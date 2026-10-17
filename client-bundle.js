/* 此文件由 scripts/assemble-client.mjs 生成，请勿手工编辑。 */
/* source: client-expert-group-model.js */
(function installExpertGroupModel(global) {
  "use strict";

  // 版本写进存储键和快照边界，防止新旧页面把同一份折叠状态误读成不同语义。
  const SCHEMA_VERSION = 1;
  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");
  const STATUSES = new Set([
    "queued", "waiting", "running", "succeeded", "failed", "cancelled",
    "timed_out", "interrupted", "idle", "ready", "unknown",
  ]);
  const STATUS_ALIASES = Object.freeze({
    canceled: "cancelled", timeout: "timed_out", timedout: "timed_out", "timed-out": "timed_out",
    success: "succeeded", successful: "succeeded", complete: "succeeded", completed: "succeeded", done: "succeeded",
    error: "failed", errored: "failed", active: "running", in_progress: "running", "in-progress": "running",
    working: "running", pending: "queued", scheduled: "queued", wait: "waiting",
  });
  const COUNT_FIELDS = Object.freeze([
    "queued", "waiting", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted", "pending",
  ]);
  /**
   * 右侧栏对外的**代理运行状态**只有这两个规范值。
   *
   * 官方源字段（DSH 子代理目录）用 activity=running/inactive、Agent status=running/idle
   * 两套词表；协议快照还带着 fan-out 的 queued/waiting/终态。展示层把它们全部收敛成
   * running|ready：只有「明确运行」才是 running，其余一律 ready。
   */
  const RUNTIME_STATUSES = Object.freeze(["running", "ready"]);
  /** 原生代理行的本地化文案（与 DSH ui-subagent locales 同源）。 */
  const MODE_LABELS = Object.freeze({ continuable: "可继续", "one-shot": "一次性" });
  const ACTIVITY_LABELS = Object.freeze({ running: "正在运行", inactive: "当前未运行" });
  /**
   * 默认折叠的状态词表：这四个状态代表「没有正在进行的工作」，默认收起。
   *
   * 提为模块级常量而不是在 defaultExpanded 里每次新建 Set：该函数位于渲染路径上，
   * 未手动覆盖展开状态的每个节点每帧都要判定一次，而词表内容恒定不变。
   */
  const DEFAULT_COLLAPSED_STATUSES = new Set(["idle", "ready", "succeeded", "cancelled"]);

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function text(value) {
    if (typeof value !== "string") return null;
    const valueText = value.trim();
    return valueText.length === 0 ? null : valueText;
  }

  function firstText() {
    for (const value of arguments) {
      const result = text(value);
      if (result !== null) return result;
    }
    return null;
  }

  function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function normalizeStatus(value) {
    const source = text(value);
    if (source === null) return "unknown";
    const key = source.toLowerCase().replace(/\s+/g, "_");
    if (STATUSES.has(key)) return key;
    return STATUS_ALIASES[key] || "unknown";
  }

  function statusFromTask(value) {
    const source = text(value);
    if (source === "pending") return "running";
    if (source === "completed" || source === "complete") return "succeeded";
    if (source === "completed_with_errors") return "failed";
    return normalizeStatus(source);
  }

  function identityOf(value) {
    const source = isObject(value) ? value : {};
    return firstText(source.id, source.sessionId, source.childId, source.parentTaskId);
  }

  function runningOf(status, explicit) {
    if (typeof explicit === "boolean") return explicit;
    if (status === "unknown") return null;
    return status === "running" || status === "waiting";
  }

  /**
   * 活动证据链（圆点与第三行文案共用同一份判定，避免两者互相矛盾）。
   *
   * 优先级固定，先命中先返回：
   * 1. 官方目录项 `activity`：running / inactive——这是 DSH 实时活动轴，最高优先级，
   *    即使 Host snapshot 的旧 running/status 与之冲突也以它为准；
   * 2. 官方目录项可识别的 `status`：running / idle；
   * 3. Host 快照的 `running` 布尔；
   * 4. 协议 `status`：running 为运行，其余已知值（idle/queued/waiting/终态）为未运行。
   * 都不成立时返回 null：展示层不猜——没有明确运行证据就落回 ready、也不加活动文案。
   * @returns {"running"|"inactive"|null}
   */
  function activitySignalOf(node, entry) {
    const source = isObject(node) ? node : {};
    const catalog = isObject(entry) ? entry : {};
    const activity = text(catalog.activity);
    if (activity === "running") return "running";
    if (activity === "inactive") return "inactive";
    const catalogStatus = text(catalog.status);
    if (catalogStatus === "running") return "running";
    if (catalogStatus === "idle") return "inactive";
    if (typeof source.running === "boolean") return source.running ? "running" : "inactive";
    const protocolStatus = normalizeStatus(source.status);
    if (protocolStatus === "running") return "running";
    if (protocolStatus !== "unknown") return "inactive";
    return null;
  }

  /**
   * 归一化代理运行状态：对外只有 running | ready。
   *
   * 只用 activitySignalOf 的活动证据链：明确运行为 running，其余（inactive、缺失、
   * 目录未命中且无其它运行证据）一律 ready。目录 activity 与 Host 旧信号冲突时，
   * 以目录 activity 为准，不把真实 running 降级成 ready。
   *
   * @param {object} node - 快照节点（专家/根/fan-out 任务或分片）。
   * @param {object} [entry] - sessions 快照里的官方目录项。
   * @returns {"running"|"ready"}
   */
  function runtimeStatusOf(node, entry) {
    return activitySignalOf(node, entry) === "running" ? "running" : "ready";
  }

  /** 只有精确命中词表的 mode 才能映射文案；未知/非法值返回 null（不猜）。 */
  function modeLabelOf(value) {
    const mode = text(value);
    if (mode === null) return null;
    return Object.prototype.hasOwnProperty.call(MODE_LABELS, mode) ? MODE_LABELS[mode] : null;
  }

  /**
   * 目录项是否显式声明「可续接性未知」（0.1.7-alpha.2 新增的 `unknown`）。
   *
   * unknown 与 one-shot 一样属于**不可续接**：它明确表示宿主尚未解析出可续接性，
   * 因此绝不能回退到节点 continuable 把它显示成「可继续」。
   */
  function isUnknownMode(value) {
    return text(value) === "unknown";
  }

  /**
   * 第三行的动态摘要：与 DSH 原生代理行同源，组合为 `title · mode · activity`。
   *
   * - title 只接受调用方从 sessions 快照读出的**权威 title**（byId[id].title）；
   * - mode：只有目录项 mode 明确为 continuable/one-shot 才显示「可继续/一次性」；
   *   非法或未知 mode 不映射（绝不当成 continuable），仅在 node.continuable 是
   *   boolean 时才回退对应文案，否则整段省略。目录项显式为 0.1.7-alpha.2 新增的
   *   `unknown` 时，它已表达「可续接性未知」的权威判定，因此**禁止**回退到节点证据：
   *   按不可续接降级，既不显示「可继续」，也不显示占位词；
   * - activity：与圆点共用 activitySignalOf 证据链，因此圆点 ready 时绝不会显示
   *   「正在运行」；只有明确 running/inactive 才映射原生文案，其余省略。
   * 实际存在的值用 " · " 连接；都不可证明时返回空串——绝不输出
   * 「无活动 / 模式未知 / 状态未知」这类占位词。
   *
   * @param {{title?: string|null, entry?: object|null, node?: object|null}} input
   * @returns {string}
   */
  function formatAgentSummary(input) {
    const source = isObject(input) ? input : {};
    const catalog = isObject(source.entry) ? source.entry : {};
    const node = isObject(source.node) ? source.node : {};
    let modeText = modeLabelOf(catalog.mode);
    // 目录项显式给出 unknown：这是「可续接性未知」的权威判定，按不可续接降级，
    // 不再回退节点 continuable（否则会把未知说成「可继续」）。
    if (modeText === null && typeof node.continuable === "boolean" && isUnknownMode(catalog.mode) !== true) {
      modeText = node.continuable ? MODE_LABELS.continuable : MODE_LABELS["one-shot"];
    }
    const activitySignal = activitySignalOf(node, catalog);
    const activityText = activitySignal === null ? null : ACTIVITY_LABELS[activitySignal];
    return [text(source.title), modeText, activityText].filter((value) => value !== null).join(" · ");
  }

  function normalizeRunSummary(value) {
    if (!isObject(value)) return null;
    const mode = value.mode === "continuable" || value.mode === "one-shot" ? value.mode : "unknown";
    const activity = value.activity === "running" || value.activity === "idle" ? value.activity : "unknown";
    return { command: text(value.command), mode, activity };
  }

  function normalizeAttempt(value) {
    const source = isObject(value) ? value : {};
    return {
      attempt: numberOrNull(source.attempt),
      status: normalizeStatus(source.status),
      childId: text(source.childId),
      startedAt: numberOrNull(source.startedAt),
      finishedAt: numberOrNull(source.finishedAt),
    };
  }

  function normalizeShard(value, inherited) {
    const source = isObject(value) ? value : {};
    const defaults = isObject(inherited) ? inherited : {};
    const attempts = Array.isArray(source.attempts) ? source.attempts.map(normalizeAttempt) : [];
    const latest = attempts.length === 0 ? null : attempts[attempts.length - 1];
    const managerStatus = source.status === undefined ? "unknown" : normalizeStatus(source.status);
    // Host 已将 fan-out manager 与 attempt 历史归并成权威状态；客户端仅在旧 Host
    // 没有投影该字段时用最新 attempt 补全，避免浏览器再次解释协议并产生漂移。
    const status = managerStatus !== "unknown" ? managerStatus : (latest?.status ?? "unknown");
    return {
      shardId: text(source.shardId),
      // taskName 是 Host 投影的权威分片任务名（优先任务名称，旧数据回退分片代号）；
      // 客户端只在旧 Host 完全没有投影该字段时才用 shardId 兜底，绝不反过来覆盖已有名称。
      taskName: firstText(source.taskName, source.shardId),
      prompt: firstText(source.prompt, source.content),
      role: firstText(source.role, defaults.role),
      provider: firstText(source.provider, defaults.provider),
      model: firstText(source.model, defaults.model),
      effort: firstText(source.effort, source.reasoningEffort, defaults.effort, defaults.reasoningEffort),
      status,
      running: runningOf(status, source.running),
      runSummary: normalizeRunSummary(source.runSummary),
      continuable: typeof source.continuable === "boolean" ? source.continuable : null,
      childId: latest?.childId ?? text(source.childId),
      createdAt: numberOrNull(source.createdAt),
      attempts,
    };
  }

  function normalizeCounts(value) {
    if (!isObject(value)) return null;
    const result = {};
    for (const field of COUNT_FIELDS) result[field] = numberOrNull(value[field]);
    return result;
  }

  function normalizeFanout(value) {
    const source = isObject(value) ? value : {};
    const parentTaskId = text(source.parentTaskId);
    const taskStatus = text(source.taskStatus) || text(source.status);
    const status = taskStatus === null ? "unknown" : statusFromTask(taskStatus);
    const rawShards = Array.isArray(source.shards) ? source.shards : [];
    return {
      id: parentTaskId,
      kind: "fanout",
      parentTaskId,
      taskName: firstText(source.taskName, source.title),
      content: firstText(source.content),
      basePrompt: firstText(source.basePrompt, source.content),
      contentSource: text(source.contentSource),
      role: text(source.role),
      provider: text(source.provider),
      model: text(source.model),
      effort: firstText(source.effort, source.reasoningEffort),
      taskStatus,
      status,
      running: runningOf(status, source.running),
      createdAt: numberOrNull(source.createdAt),
      counts: normalizeCounts(source.counts),
      shards: rawShards.map((shard) => normalizeShard(shard, source)),
    };
  }

  function normalizeSessionNode(value, kind, fallbackId) {
    const source = isObject(value) ? value : {};
    const id = firstText(source.id, source.sessionId, fallbackId);
    const status = normalizeStatus(source.status);
    return {
      id,
      kind,
      sessionId: firstText(source.sessionId, source.id, fallbackId),
      taskName: firstText(source.taskName, source.task, source.title, source.displayTitle, source.label, source.name),
      content: firstText(source.content, source.prompt),
      contentSource: text(source.contentSource),
      role: text(source.role),
      provider: text(source.provider),
      model: text(source.model),
      effort: firstText(source.effort, source.reasoningEffort),
      status,
      running: runningOf(status, source.running),
      runSummary: normalizeRunSummary(source.runSummary),
      continuable: typeof source.continuable === "boolean" ? source.continuable : null,
      createdAt: numberOrNull(source.createdAt),
      children: [],
    };
  }

  function attemptChildIds(nodes) {
    const ids = new Set();
    for (const node of nodes) {
      if (node.kind !== "fanout") continue;
      for (const shard of node.shards) for (const attempt of shard.attempts) {
        if (attempt.childId !== null) ids.add(attempt.childId);
      }
    }
    return ids;
  }

  function childSourceList(raw, root) {
    if (Array.isArray(root?.children)) return root.children;
    const expertChildren = Array.isArray(raw?.experts) ? raw.experts : [];
    const fanoutChildren = Array.isArray(raw?.fanoutTasks)
      ? raw.fanoutTasks
      : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    return [...expertChildren, ...fanoutChildren];
  }

  function normalizeExpertGroupSnapshot(raw) {
    if (!isObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) return null;
    const sourceRoot = isObject(raw.root) ? raw.root : {};
    const rootSessionId = firstText(raw.rootSessionId, raw.sessionId, sourceRoot.sessionId, sourceRoot.id);
    if (rootSessionId === null) return null;
    const root = normalizeSessionNode(sourceRoot, "root", rootSessionId);
    root.sessionId = rootSessionId;
    root.id = rootSessionId;
    const rawChildren = childSourceList(raw, sourceRoot);
    const children = rawChildren.map((child) => {
      const kind = isObject(child) && child.kind === "fanout" ? "fanout" : "expert";
      return kind === "fanout" ? normalizeFanout(child) : normalizeSessionNode(child, "expert");
    });
    const fanoutIds = attemptChildIds(children);
    root.children = children.filter((child) => child.kind !== "expert" || child.sessionId === null || !fanoutIds.has(child.sessionId));
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId: rootSessionId,
      rootSessionId,
      generatedAt: numberOrNull(raw.generatedAt),
      root,
    };
  }

  function titleCaseRole(value, fallback) {
    const source = text(value);
    if (source === null) return fallback;
    return source
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ") || fallback;
  }

  function formatExpertMetadata(node) {
    const source = isObject(node) ? node : {};
    const role = titleCaseRole(source.role, source.kind === "root" ? "Orchestrator" : "Expert");
    const provider = text(source.provider) || "未知供应商";
    const model = text(source.model) || "未知模型";
    const rawEffort = firstText(source.effort, source.reasoningEffort);
    const effort = rawEffort === null ? "默认" : rawEffort.charAt(0).toUpperCase() + rawEffort.slice(1);
    return [role, provider, model, effort].join(" · ");
  }

  function defaultExpanded(node) {
    // 根节点是任务树入口，默认展开；空闲分组也默认展示成员。
    if (isObject(node) && node.kind === "root") return true;
    if (isObject(node) && node.kind === "idle-group") return true;
    // fan-out 始终默认展示子代理，不因完成或取消自动收起；
    // 这里只改变缺省值，createExpansionStore 仍优先保留用户手动折叠的选择。
    if (isObject(node) && node.kind === "fanout") return true;
    const status = normalizeStatus(isObject(node) ? (node.status ?? node.taskStatus) : undefined);
    return !DEFAULT_COLLAPSED_STATUSES.has(status);
  }

  function taskIdOf(value) {
    if (typeof value === "string") return text(value) || "unknown";
    const source = isObject(value) ? value : {};
    return firstText(source.taskId, source.id, source.parentTaskId, source.sessionId, source.shardId) || "unknown";
  }

  function safeStorage(storage) {
    if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") return storage;
    try {
      const candidate = global.sessionStorage;
      if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    } catch { /* 某些浏览器隐私模式访问 sessionStorage 会同步抛错，按无持久化降级。 */ }
    return null;
  }

  function createExpansionStore(options) {
    const config = isObject(options) ? options : {};
    const storage = safeStorage(config.storage);
    const rootSessionId = text(config.rootSessionId) || "unknown";
    const keyFor = (value) => "dsh-expert-group:expansion:v" + SCHEMA_VERSION + ":" + encodeURIComponent(rootSessionId) + ":" + encodeURIComponent(taskIdOf(value));
    const readOverride = (key) => {
      if (storage === null) return undefined;
      try {
        const raw = storage.getItem(key);
        if (raw === null || raw === undefined) return undefined;
        if (raw === "true") return true;
        if (raw === "false") return false;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "boolean") return parsed;
        if (isObject(parsed) && typeof parsed.expanded === "boolean"
          && (parsed.schemaVersion === undefined || parsed.schemaVersion === SCHEMA_VERSION)) return parsed.expanded;
      } catch { /* 损坏内容和存储读错误都只表示没有手动 override。 */ }
      return undefined;
    };
    const isExpanded = (value) => {
      const override = readOverride(keyFor(value));
      return override === undefined ? defaultExpanded(value) : override;
    };
    const setExpanded = (value, expanded) => {
      const next = expanded === true;
      if (storage !== null) {
        try {
          storage.setItem(keyFor(value), JSON.stringify({ schemaVersion: SCHEMA_VERSION, rootSessionId, taskId: taskIdOf(value), expanded: next }));
        } catch { /* 配额或隐私策略拒绝写入时仍保留本次渲染的默认行为。 */ }
      }
      return next;
    };
    const toggle = (value) => setExpanded(value, !isExpanded(value));
    const clear = (value) => {
      if (storage === null || typeof storage.removeItem !== "function") return;
      try { storage.removeItem(keyFor(value)); } catch { /* 清理失败不影响页面。 */ }
    };
    return Object.freeze({
      rootSessionId, keyFor, isExpanded, get: isExpanded,
      setExpanded, set: setExpanded, toggle, clear,
    });
  }

  global[SYMBOL] = Object.freeze({
    SCHEMA_VERSION,
    RUNTIME_STATUSES,
    normalizeExpertGroupSnapshot,
    normalizeStatus,
    runtimeStatusOf,
    formatAgentSummary,
    formatExpertMetadata,
    defaultExpanded,
    createExpansionStore,
  });
})(globalThis);

/* source: client-expert-group-sidebar.js */
(function installExpertGroupSidebar(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-sidebar");
  const MODEL_SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");
  const MODEL = global[MODEL_SYMBOL] || {};
  const modelApi = () => global[MODEL_SYMBOL] || MODEL;
  /** 右侧栏对外的代理运行状态只有 running | ready 两个规范值。 */
  const RUNTIME_STATUS_LABELS = Object.freeze({ running: "running", ready: "ready" });
  /**
   * 规范运行状态到 primitives.StateDot 的语义映射：
   * running 用 ongoing（DSH 原生 1 秒追逐动画），ready 用 done（绿色静态圆点）。
   * 插件不自造第二套动画，动画只由官方组件提供。
   */
  const RUNTIME_STATE_DOT = Object.freeze({ running: "ongoing", ready: "done" });
  // ACTIVE_STATUSES / RETRY_STATUSES 只服务于 fan-out 管理语义（取消/重试判定），不是展示状态词表。
  const ACTIVE_STATUSES = new Set(["queued", "waiting", "running"]);
  const RETRY_STATUSES = new Set(["failed", "timed_out", "interrupted"]);
  // 父任务的规范终态表示全部分片已结算，且不会把未知/展示态误判为空闲。
  const FANOUT_SETTLED_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
  const STYLE_ID = "dsh-expert-group/expert-group-sidebar";
  /**
   * Expert Group 页的右侧栏宽度：**恒为视口宽度的 20%**（1600px 视口 ⇒ 320px）。
   *
   * 这是精确比例，插件不做最小值 clamp；最终落值交给宿主 setRightbar 自己的 clamp。
   * 当用户切到同一右栏里的其它页面时，右栏切到 50% 的可调模式，避免窄栏让新页面
   * 静默回落后再被插件浮出成独立窗口。
   */
  const RIGHTBAR_WIDTH_RATIO = 0.2;
  const OTHER_RIGHTBAR_WIDTH_RATIO = 0.5;
  /**
   * 「宿主里那份右栏宽度是否仍是插件写的」的匹配容差（px）。
   *
   * 面板的实际渲染宽度会被浏览器做子像素取整与布局舍入，不可能与插件写入的整数 target 逐字节
   * 相等；1px 足以覆盖这类规范化，又远小于任何一次真实用户拖拽（拖拽是数十像素量级），因此
   * 不会把「用户已经改过宽度」误判成「还是插件那份值」。
   */
  const RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX = 1;
  /**
   * 同一个「未收敛的宽度 mismatch」允许的**恢复写入**上限（次）。
   *
   * 背景：宿主可能持续 clamp（请求 640，只渲染 320），或 React 延迟若干帧才把新宽度提交到 DOM。
   * 这两种情况下「面板实际渲染宽度 != 插件 target」会一直是真，而它同时又是「宿主夺回了那份 px」
   * 的证据；若每条同步路径（面板 observer / 2.5 秒轮询 / sessions 通知）都据此 force 重写，
   * 就会与宿主的 clamp 无限拉锯：layout store 被同一个值反复改写、宿主反复重渲染（用户看到抖动）。
   *
   * 因此用一份 per-session 状态跟踪同一个恢复事件（session、**当前视口下预期**的 target、
   * 观测到的实际宽度），同一个未收敛 mismatch 最多执行 2 次恢复写入：一次立即恢复 + 一次重试，
   * 足以覆盖「宿主延迟一帧才提交」这类真实时序；再多就只是拉锯。上限**不能**被正常轮询自行重置——
   * 只有观测到实际宽度已经等于 target（收敛）、**预期 target 真的改变**、所有权周期变化或 dispose
   * 时才清除状态。
   *
   * 事件同一性里的 target 必须是**按当前视口算出来的预期值**，而不是「上次成功写入的值」：宿主持续
   * clamp 时，视口从 3200 挪到 3201 / 3202，20% 取整后仍是同一个 640，那份 px 依然代表 20%——
   * 这不是新的一次 mismatch，绝不能因此重新获得预算；只有窗口真正最大化（3200 → 4000，预期
   * 640 → 800）才是一次新事件。否则用户轻微拖动窗口边缘就能无限重写，正是本预算要挡住的形状。
   */
  const RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS = 2;
  /**
   * DEG 的品牌图标 artwork：与宿主「智能体团队」入口同源的双人（users）图标。
   *
   * 4 条 path 逐字节取自宿主 primitives 的 IconUsersOutlineRegular（16×16 网格、1px 描边：
   * 前一人的头/肩轮廓 + 后面第二人的两条轮廓）。宿主新版本已导出该具名组件，运行期优先直接
   * 复用它；本包的依赖版本（0.1.7-alpha.2）只有单人的 IconUserOutlineRegular，因此缺导出时
   * 回落到本模块用同一组 path 构造的等价组件——两条路径下品牌图标的形状完全一致。
   *
   * 这是运行期取用的唯一一份路径数据：侧栏 better tab / 原生 guide 图标与 client.js 的设置页
   * 导航图标都从这里取（client.js 只在侧栏 IIFE 缺失时才用自己那份同值兜底字面量）。
   */
  const BRAND_ICON_PATHS = Object.freeze([
    "M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
    "M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
    "M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
    "M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
  ]);

  /**
   * 右栏 tab 的宿主渲染观测标记（不是 sidebarRight service 的方法契约）。
   *
   * DSH 右栏把停靠 tab 渲染成 `[data-sidebar-right-panel] [data-dockkit-tab="<tabId>"]`，
   * tabId 与 `sidebarRight.active()/close()` 使用的 id 同源。插件只读这些标记判断 tab/列组成；
   * 布局适配只在组成可证明时向 split 容器写入受控的 `grid-template-columns`，不注册自己的
   * class、不改 DOM 结构、也不依赖 CSS module hash。
   *
   * 真实 DockKit 层级（右栏已分栏时）：
   *   [data-sidebar-right-panel][data-sidebar-right-session]
   *     [data-dockkit-split]                     ← 实际列宽由它的内联 grid-template-columns 决定
   *       div[data-dockkit-host="dock"][data-dockkit-column="0"]
   *         [data-dockkit-strip-tabs] > [data-dockkit-tab="<tabId>"]   ← tab 在列的后代里
   *       div[data-dockkit-host="dock"][data-dockkit-column="1"] …
   * `data-dockkit-pane` 只出现在活跃的非浮动 section 上，因此**不能**用它当列的唯一判据。
   */
  const RIGHTBAR_PANEL_SELECTOR = "[data-sidebar-right-panel]";
  /** 面板的会话归属：只有与当前 surface 的会话完全相等才允许被选中。 */
  const RIGHTBAR_PANEL_SESSION_ATTRIBUTE = "data-sidebar-right-session";
  const RIGHTBAR_TAB_SELECTOR = "[data-dockkit-tab]";
  const RIGHTBAR_TAB_ID_ATTRIBUTE = "data-dockkit-tab";
  const RIGHTBAR_PANE_SELECTOR = "[data-dockkit-pane]";
  const RIGHTBAR_PANE_ID_ATTRIBUTE = "data-dockkit-pane";
  const RIGHTBAR_PANE_COLUMN_ATTRIBUTE = "data-dockkit-column";
  /** 分栏容器与 dock 列（cell）的公开标记。 */
  const RIGHTBAR_SPLIT_SELECTOR = "[data-dockkit-split]";
  const RIGHTBAR_SPLIT_ATTRIBUTE = "data-dockkit-split";
  const RIGHTBAR_DOCK_HOST_ATTRIBUTE = "data-dockkit-host";
  const RIGHTBAR_DOCK_HOST_VALUE = "dock";
  /** 列自己的 tab 条容器：tab 芯片是它的后代，不是列/pane 的直接子节点。 */
  const RIGHTBAR_STRIP_TABS_SELECTOR = "[data-dockkit-strip-tabs]";
  const RIGHTBAR_STRIP_TABS_ATTRIBUTE = "data-dockkit-strip-tabs";
  /**
   * 首次分栏后的列宽配比。
   *
   * 用户第一次点行尾 >> 分栏时，宿主把右栏总宽度临时扩到视口的 50%；而 DockKit 的分栏默认
   * 把两条列轨**等分**（`minmax(0,0.5fr) 0px minmax(0,0.5fr)`），于是 Expert Group 页只占
   * 视口的 25%（右栏 1/2 × 50%）。本插件不改宿主那份总宽度（它仍必须是 50%），只按
   * 「列 0 是 Expert Group、列 1 是当前 session 的另一个已知页」这条唯一可证明的组成关系，
   * 把 split 容器的内联 `grid-template-columns` 写成 `minmax(0,0.4fr) 0px minmax(0,0.6fr)`：
   *
   * - grid 轨道按各自的 fr 分配可用宽度，因此 0.4 : 0.6 就是 40% : 60%；
   * - 右栏总宽 50% × 40% = 视口 20%（Expert Group 页），50% × 60% = 视口 30%（子代理页）；
   * - 中间那条 0px 分隔轨由 parseSplitTracks 原样保留，插件绝不改写它（不同 DSH 版本可能
   *   是别的宽度，它不属于配比语义）。
   *
   * 只用这一条内联属性：列内的 flex-grow 不参与真实列宽计算，插件也绝不碰宿主的其它声明。
   */
  const SIDEBAR_SPLIT_EXPERT_TRACK = "0.4";
  const SIDEBAR_SPLIT_OTHER_TRACK = "0.6";
  /**
   * 宿主当前没有内联轨道声明时使用的规范分隔轨。
   *
   * 真实右栏的分隔轨是 0px；只有当 split 上**没有**任何内联 grid-template-columns 时才用它
   * （宿主换成了别的非三轨写法时插件不会写，见 applyRatio 的承载性判定）。
   */
  const SIDEBAR_SPLIT_GAP_TRACK = "0px";
  /** 插件这唯一一次分栏布局写入的属性名（恢复判定与写入共用同一常量）。 */
  const SIDEBAR_SPLIT_TRACK_PROPERTY = "grid-template-columns";
  /** Expert Group 的 kind；兼容旧宿主把 kind 直接用于 data-dockkit-tab 的 DOM 形态。 */
  const EXPERT_GROUP_TAB_IDS = new Set(["dsh-expert-group", "expert-group"]);
  /**
   * DockKit 新版会把 kind 加计数器生成 tabId（例如 dsh-expert-group1）。当 openTabs 暂时
   * 不可读时，仍可从公开 DOM 标记识别这种真实 id；无法识别的随机 id 则保持 fail-closed。
   */
  function isGeneratedExpertGroupTabId(value) {
    return typeof value === "string" && /^(?:dsh-)?expert-group\d+$/.test(value);
  }
  /** 浮动 tab 没有 tabId 属性，只能用 subagentchat body + 打开时的标题做保守正向证据。 */
  const RIGHTBAR_FLOAT_SELECTOR = "[data-dockkit-float]";
  const RIGHTBAR_FLOAT_TITLE_SELECTOR = "[data-dockkit-float-title]";

  /**
   * 外部关闭的确认次数：目标 tab 连续两次被观测到从 DOM 里消失，才把箭头复位成 `>>`。
   *
   * 为什么不是一次：观测点（MutationObserver 回调、2.5 秒轮询、visibilitychange）可能落在宿主
   * 提交窗口的中间态上——面板刚展开、tab 已入 store 但 DOM 还没提交，甚至面板被整体重挂载。
   * 一次缺失不足以证明用户关掉了 tab，而「连续两次缺失」在时间上必然跨越了这些过渡帧。
   * 任一正向证据（tab 节点仍在，或 active() 就是目标 tab）都会把计数清零。
   */
  const SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS = 2;
  /** 打开后等待 active() 提交的最长时间；超时只释放待确认记录，不伪造 << 状态。 */
  const SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS = 15000;
  /** 首次 split 的跨 inventory/DOM 提交 deadline，避免临时 50% 状态无限期占用右栏。 */
  const SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS = 15000;
  /** RAF 被后台节流时的短 fallback；只负责放行一次 split 尝试，不改变事务提交 deadline。 */
  const SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS = 250;
  /**
   * 「分栏配比暂不可读」时的短延迟重试参数。
   *
   * 场景：DSH 重启后宿主从持久化布局恢复右栏分栏，第二列的 tab 条 / inventory 归属会**比
   * split 容器晚若干帧**才提交。此时既不能证明组成仍成立，也不能证明组成已失效；旧实现把
   * 「读不出来」直接当成「组成失效」立刻交还宿主，用户看到 40/60 → 50/50 的闪回。
   *
   * 因此这类「暂不可读」只在**已经写进过目标配比**之后进入 pending：保持当前样式并安排一次
   * 短延迟重试（去重：同一时刻最多一个待执行重试），读面恢复后由重试或任何一次既有同步自动
   * 重新落回目标配比。重试预算用尽仍读不出来时按「组成确实失效」交还宿主——预算有界，绝不
   * 无限重排定时器，也不会把 0.4/0.6 无限期留在真实的单列结构上。
   */
  const SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS = 400;
  const SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS = 4;
  /** 侧栏打开状态的复合键分隔符：会话 id、rootSessionId 与资源地址都是单行文本，NUL 不会出现在其中。 */
  const SIDEBAR_TAB_KEY_SEPARATOR = "\u0000";
  /**
   * 右栏 tab 的两个来源。
   *
   * - `auto`：「自动打开」（Auto）本次运行亲手打开的 tab，只有它允许被自动关闭；
   * - `manual`：用户点击箭头打开、或外部已存在但不由本插件自动动作发起的 tab。
   * 双来源是「手动优先」判定唯一依据：自动同步绝不关闭 manual 来源的 tab。
   */
  const SIDEBAR_TAB_ORIGIN_AUTO = "auto";
  const SIDEBAR_TAB_ORIGIN_MANUAL = "manual";
  /**
   * 自动关闭的有界重试上限。
   *
   * 宿主 close(tabId) 可能同步抛错或长期失败；自动同步每 2.5 秒一轮，没有上限就会变成
   * 后台重试风暴。达到上限后只撤销「这是 Auto 打开的」记账（tab 原样留给用户手动关闭），
   * 绝不猜测 tabId、也绝不改用批量关闭入口。
   */
  const SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS = 3;
  /**
   * 自动来源/抑制记集合的条目上限（按插入顺序淘汰最旧一项）。
   *
   * 复合键含 rootSessionId：面板实例跨多个 root 复用时，别的 root 的键在当前快照里无法判定
   * 是否仍然存在（快照只描述当前 root），因此除了「快照里已消失就清理」之外还需要这条上限，
   * 保证长期运行的面板不会无界增长。
   */
  const SIDEBAR_AUTO_KEY_LIMIT = 128;

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function text(value, fallback) {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    return value.trim();
  }

  /**
   * 读取当前视口宽度（px）；读不到（没有 window、非有限数、非正数）时返回 null。
   *
   * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store 的
   * 是像素值；因此「换算」与「视口是否变了」必须共用这一个读面，绝不能在两处各读一次
   * （那会让比例换算与变化检测读到不同的视口）。读不到时返回 null，调用方一律放弃写入，
   * 保留宿主当前值，绝不猜一个宽度。
   */
  function viewportWidthOf() {
    let value = null;
    try { value = globalThis.window?.innerWidth ?? globalThis.innerWidth; } catch { value = null; }
    const width = Number(value);
    return Number.isFinite(width) && width > 0 ? width : null;
  }

  /**
   * 元素查询的三种结果。**必须区分「没命中」与「读面有歧义」**，两者对调用方的含义完全不同：
   *
   * - `missing`：这个选择器在当前 DOM 里确实一个都没命中。它表示「当前宿主版本没有这个读法」，
   *   调用方可以继续尝试其它选择器；
   * - `unique`：恰好命中一个元素，可以当作证据使用；
   * - `ambiguous`：命中多个（读面有歧义，例如新旧 frame 同时残留），或查询本身抛错 / 读面不可用
   *   （无 document、没有 querySelectorAll、代理抛错）。它**不是**「这个读法不存在」，因此绝不允许
   *   被别的选择器「兜底」掩盖掉——把多命中降级成 missing 会让旧节点的唯一候选冒充当前 AppFrame。
   */
  const ELEMENT_QUERY_MISSING = "missing";
  const ELEMENT_QUERY_UNIQUE = "unique";
  const ELEMENT_QUERY_AMBIGUOUS = "ambiguous";

  /**
   * 查询一个选择器，返回 `{ status, element }`（element 只在 unique 时非 null）。
   *
   * 只返回这三种状态，任何异常都归一为 `ambiguous`（读不出来 ≠ 读到了空），绝不抛给调用方，
   * 也绝不按 DOM 顺序取第一个命中：第一个命中无法证明它就是目标元素。
   */
  function elementQueryOf(doc, selector) {
    let nodes = null;
    try {
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") {
        return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
      }
      nodes = Array.from(doc.querySelectorAll(selector));
    } catch {
      return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    }
    if (nodes.length === 0) return { status: ELEMENT_QUERY_MISSING, element: null };
    if (nodes.length > 1) return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    return { status: ELEMENT_QUERY_UNIQUE, element: nodes[0] };
  }

  /**
   * 解析当前宿主的 AppFrame 根元素；无法**唯一**定位时返回 null。
   *
   * 只用宿主公开的 DOM 标记，与本文件既有的 AppFrame 读法（rightbarTransitionTargets）一致：
   * 1. 主读法 [data-shell-overlay]：覆盖层是 AppFrame 的**直接子节点**，其 parentElement 即 AppFrame；
   * 2. 兜底 [data-rightbar-collapsed] / [data-rightbar-instant]：AppFrame 自己的公开状态属性
   *    （旧宿主可能没有覆盖层）。
   *
   * 歧义传播规则（本函数的 fail-closed 边界）：
   * - 任何一个选择器**多命中或查询异常** → 立刻返回 null，不再看后面的读法：此时读面已经不可信，
   *   让另一个选择器的唯一候选去「兜底」等于用旧 frame 冒充当前 AppFrame；
   * - 只有真正 `missing`（零命中）才继续尝试下一个选择器；
   * - 候选元素去重后必须**恰好一个**：零个表示定位不到 AppFrame，多个不同元素表示读面有歧义
   *   （比如新旧 frame 同时残留），两者都返回 null——调用方按「读不到」处理，绝不挑一个猜。
   */
  function appFrameElementOf(doc) {
    const candidates = [];
    const push = (element) => {
      if (element === null || element === undefined || element.nodeType !== 1) return;
      if (candidates.includes(element) === false) candidates.push(element);
    };
    const overlay = elementQueryOf(doc, "[data-shell-overlay]");
    if (overlay.status === ELEMENT_QUERY_AMBIGUOUS) return null;
    if (overlay.status === ELEMENT_QUERY_UNIQUE) {
      let parent = null;
      try { parent = overlay.element.parentElement ?? null; } catch { parent = null; }
      push(parent);
    }
    for (const selector of ["[data-rightbar-collapsed]", "[data-rightbar-instant]"]) {
      const state = elementQueryOf(doc, selector);
      if (state.status === ELEMENT_QUERY_AMBIGUOUS) return null;
      if (state.status === ELEMENT_QUERY_UNIQUE) push(state.element);
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 读取当前宿主 AppFrame 的宽度（px）；定位不到、尺寸非法时返回 null。
   *
   * 为什么不能拿 window.innerWidth 顶替：宿主 LayoutController 维护的 layout store 里那份
   * viewportWidth 是用 **AppFrame 根元素的 getBoundingClientRect().width** 更新的，它是右栏宽度
   * 上限 clamp 的参照系，并不恒等于 window.innerWidth（页面缩放、滚动条、外层留白、嵌入形态都会
   * 让两者不等）。把 innerWidth 写进宿主那个权威槽位等于换了一个量去改宿主的判据：frame 比 window
   * 窄时反而抬高上限，写出宿主自己永远不会写的宽度。
   *
   * fail-closed 边界（绝不猜测宿主尺寸）：
   * - AppFrame 定位不到或归属有歧义（见 appFrameElementOf）→ null；
   * - 解析结果就是 document.body / document.documentElement → null：它们是「整个文档」，
   *   不是 AppFrame，宽度语义完全不同，绝不拿它们顶替；
   * - 没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数 → null。
   */
  function hostAppFrameWidthOf() {
    try {
      const doc = globalThis.document;
      const frame = appFrameElementOf(doc);
      if (frame === null) return null;
      if (frame === doc?.body || frame === doc?.documentElement) return null;
      const rect = typeof frame.getBoundingClientRect === "function" ? frame.getBoundingClientRect() : null;
      if (rect === null || typeof rect !== "object") return null;
      const width = Number(rect.width);
      return Number.isFinite(width) && width > 0 ? width : null;
    } catch { return null; }
  }

  /**
   * 取一个方法而不读取它的调用形态。
   *
   * Cordis 的服务代理对未声明属性可能直接抛错，因此属性读取一律包在 try 里；
   * 只返回「确实是函数」的候选，其它（缺失、proxy 抛错、非函数属性）统一按 null 处理，
   * 调用方据此走兼容路径而不是拿到一个到调用时才炸的引用。
   */
  function methodOf(target, name) {
    if (target === null || target === undefined) return null;
    try {
      const candidate = target[name];
      return typeof candidate === "function" ? candidate : null;
    } catch { return null; }
  }

  /**
   * 安全解析一个可选客户端服务（uiWorkspace / sidebarRight / sessions 等）。
   *
   * 每个候选项都按「get(name) → 直接属性」两段式探测：Cordis 的服务代理对未声明服务的
   * 属性读取会抛错，任何一层失败都只表示「这个候选项没有它」，继续看下一个。
   * 查找顺序由调用方给出（本插件约定：显式注入的 deps → tab 的 props.ctx → install ctx），
   * 全部未命中返回 null —— 调用方必须据此走兼容路径，绝不把异常带进渲染路径。
   */
  function resolveClientService(candidates, name) {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      try {
        if (typeof candidate.get === "function") {
          const value = candidate.get(name);
          if (value !== null && value !== undefined) return value;
        }
      } catch { /* 未声明服务读取即抛错：按「该候选没有它」处理。 */ }
      try {
        const value = candidate[name];
        if (value !== null && value !== undefined) return value;
      } catch { /* 同上。 */ }
    }
    return null;
  }

  /**
   * DSH 原生 subagentchat 侧栏资源地址前缀。
   * 与 `@deepseek-ai/dsh-client-ui-subagent` 的 SUBAGENT_CHAT_ADDRESS 同值：
   * 地址由宿主原生 tab 类型解析，插件只负责生成同一个规范形状。
   */
  const SUBAGENT_CHAT_ADDRESS_PREFIX = "dsh-resource://subagentchat/session/";
  /** `sidebarRight.openResource` 的 kind：声明「这个地址由 subagentchat tab 认领」。 */
  const SUBAGENT_CHAT_KIND = "subagentchat";
  /**
   * 目录项 mode 的三个规范值（0.1.7-alpha.2 新增 `unknown`）。
   *
   * `unknown` 表示宿主的父目录只保留了身份、尚未解析出可续接性（读取 child 会话历史后才能确定）。
   * 插件因此按**不可续接**降级展示：地址照旧可构造（宿主原生主视图与侧栏都能处理该值），
   * 但不显示任何「可继续」相关文案或续接入口。已知模式（one-shot / continuable）行为完全不变。
   */
  const SUBAGENT_MODES = new Set(["one-shot", "continuable", "unknown"]);

  /**
   * 把任意来源的地址候选归一为 SubagentAddress（{ parentSessionId, childSessionId, mode }）。
   *
   * 只接受三个字段齐全、mode 是规范值（含新增的 `unknown`）的对象；字段名兼容 DSH 的正式命名
   * 与目录项里常见的别名（parentId / id / sessionId），任何缺失或非法值都返回 null（fail-closed）。
   */
  function normalizeSubagentAddress(value) {
    const source = object(value);
    const parentSessionId = text(source.parentSessionId, text(source.parentId, null));
    const childSessionId = text(source.childSessionId, text(source.id, text(source.sessionId, null)));
    const mode = text(source.mode, null);
    if (parentSessionId === null || childSessionId === null || mode === null) return null;
    if (SUBAGENT_MODES.has(mode) !== true) return null;
    return { parentSessionId, childSessionId, mode };
  }

  /**
   * 构造 subagentchat 资源地址：
   * `dsh-resource://subagentchat/session/<encodeURIComponent(child)>?parent=<URLSearchParams(parent)>&mode=<URLSearchParams(mode)>`。
   *
   * 路径段与查询串分别复用 DSH 原生实现的编码方式（查询串由 URLSearchParams 生成，空格为 +），
   * 因此宿主原生侧栏聊天 tab 能直接解析并定位到该子代理会话。地址不可构造时返回 null。
   */
  function subagentChatAddress(value) {
    const address = normalizeSubagentAddress(value);
    if (address === null) return null;
    const query = typeof global.URLSearchParams === "function"
      ? new global.URLSearchParams({ parent: address.parentSessionId, mode: address.mode }).toString()
      : "parent=" + encodeAddressPart(address.parentSessionId) + "&mode=" + encodeAddressPart(address.mode);
    return SUBAGENT_CHAT_ADDRESS_PREFIX
      + encodeAddressPart(address.childSessionId)
      + "?" + query;
  }

  /** 资源地址里的会话 id 按 DSH 的规范做路径百分号编码；查询串优先由 URLSearchParams 负责编码。 */
  function encodeAddressPart(value) {
    const raw = String(value);
    return typeof encodeURIComponent === "function" ? encodeURIComponent(raw) : raw;
  }

  /**
   * 侧栏打开状态的复合键：sessionId + rootSessionId + 资源地址。
   *
   * DSH 的 Tab 域按（Session，tabId）保留记录；同一个 root 可能在 root/child surface 各有一份
   * session-scoped 右栏。因此键必须同时含当前 session、所属 root 和资源地址，避免把一个 surface
   * 的关闭箭头或 tabId 借给另一个 surface。
   */
  function sidebarTabKey(sessionId, rootSessionId, resourceAddress) {
    return String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR
      + String(rootSessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(resourceAddress);
  }

  function sessionEntries(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
      if (value.every((entry) => Array.isArray(entry) && entry.length >= 2)) return value;
      return value.map((entry, index) => [String(index), entry]);
    }
    if (typeof value.entries === "function") {
      try { return Array.from(value.entries()); } catch { return []; }
    }
    if (typeof value === "object") return Object.entries(value);
    return [];
  }

  function sessionIdOf(value, fallback) {
    const source = object(value);
    return text(source.sessionId, text(source.id, text(fallback, null)));
  }

  /**
   * 读取宿主当前可见的会话。
   *
   * 旧版 DSH 在 sessions 快照上提供 `current` 字段；0.1.6-alpha.2 的
   * SessionListState 已移除该字段，当前主视图改由对应会话的
   * `retainedBy.mainView > 0` 表示。这里集中兼容两种公开快照形状，避免自动打开、
   * 原生回退和面板首屏各自维护一份过期的 current 读取逻辑。
   */
  function currentSessionIdOf(snapshot) {
    const source = object(snapshot);
    const explicit = text(source.current, null);
    if (explicit !== null) return explicit;
    // 兼容未来/过渡宿主把当前会话包装成 { id/sessionId } 的只读值。
    const currentObject = sessionIdOf(source.current, null);
    if (currentObject !== null) return currentObject;
    // 显式 current=null 是宿主报告「当前没有可见 surface」，不能再用 retainedBy.mainView
    // 的旧兼容证据把已经消失的会话复活，否则事务取消永远看不到 session-null 边沿。
    if (source.current === null) return null;
    const named = text(source.currentSessionId, text(source.activeSessionId, null));
    if (named !== null) return named;
    for (const [fallback, value] of sessionEntries(source.byId ?? source.sessions)) {
      const summary = object(value);
      const retainedBy = object(summary.retainedBy);
      const mainView = retainedBy.mainView;
      if ((typeof mainView === "number" && mainView > 0) || mainView === true) {
        return sessionIdOf(summary, fallback);
      }
    }
    return null;
  }

  function parentIdOf(value) {
    const source = object(value);
    const origin = object(source.origin);
    return text(source.parentId, text(source.parentSessionId, text(origin.parentId, text(origin.parentSessionId, null))));
  }

  function listSnapshot(deps, ctx) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.getSnapshot === "function") {
      try { return list.getSnapshot() || {}; } catch { return {}; }
    }
    if (typeof sessions?.getSnapshot === "function") {
      try { return sessions.getSnapshot() || {}; } catch { return {}; }
    }
    return sessions?.snapshot || {};
  }

  function rootIdsOf(deps, ctx) {
    const snapshot = listSnapshot(deps, ctx);
    const entries = sessionEntries(snapshot.byId ?? snapshot.sessions ?? snapshot);
    const sessions = new Map();
    for (const [fallback, value] of entries) {
      const id = sessionIdOf(value, fallback);
      if (id !== null) sessions.set(id, value);
    }
    const roots = new Set();
    for (const [id, value] of sessions) {
      let rootId;
      if (typeof deps.resolveRootSessionId === "function") {
        try { rootId = deps.resolveRootSessionId(id, value, snapshot); } catch { rootId = undefined; }
      }
      rootId = text(rootId, null);
      if (rootId === null) {
        let current = id;
        const visited = new Set();
        while (!visited.has(current)) {
          visited.add(current);
          const parent = parentIdOf(sessions.get(current));
          if (parent === null || parent === current || !sessions.has(parent)) break;
          current = parent;
        }
        rootId = current;
      }
      if (rootId !== null) roots.add(rootId);
    }
    // 会话列表还没 hydration 时，当前会话仍是一个可寻址的根。
    if (roots.size === 0) {
      const current = currentSessionIdOf(snapshot);
      if (current !== null) {
        let rootId = current;
        if (typeof deps.resolveRootSessionId === "function") {
          try { rootId = text(deps.resolveRootSessionId(current, undefined, snapshot), current); } catch { /* 使用 current。 */ }
        }
        roots.add(rootId);
      }
    }
    return [...roots];
  }

  /**
   * 自动打开目标：所有已知 root 会话 ∪ 宿主当前可见会话。
   *
   * 右侧栏页面是按会话 surface 挂载的：root 会话与 child（子代理）会话各自有自己的
   * surface。只遍历 root 会让「用户当前正在看的 child 会话」永远不自动打开，因此把
   * 当前会话也纳入目标——它本身可能就是 child，也可能是一个尚未进入 byId 的 root。
   *
   * 目标按会话 id 精确去重（Set）：root 与 child 是不同 surface，不会互相折叠；
   * 当前会话恰好等于某个已知 root 时也只保留一项。root 排在前面，保持原有打开顺序。
   */
  function openTargetIdsOf(deps, ctx) {
    const targets = new Set(rootIdsOf(deps, ctx));
    const current = currentSessionIdOf(listSnapshot(deps, ctx));
    if (current !== null) targets.add(current);
    return [...targets];
  }

  function subscribeSessions(deps, ctx, listener) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.subscribe === "function") {
      try { return list.subscribe(listener); } catch { return () => {}; }
    }
    if (typeof sessions?.subscribe === "function") {
      try { return sessions.subscribe(listener); } catch { return () => {}; }
    }
    return () => {};
  }

  /**
   * 解析「打开会话」入口：只使用工作区服务的公开导航面 `uiWorkspace.openSession(target)`。
   *
   * 返回 `{ open, acceptsAddress, available }`：
   * - `open(target)`：真正可调用的导航入口；
   * - `acceptsAddress`：该入口是否认识 SubagentAddress；
   * - `available`：宿主是否提供了这个入口。为 false 时调用方**不渲染**任何导航入口，
   *   绝不显示点了没反应的按钮（已删除的 `sessions.open` / `ctx.sessions.open` /
   *   历史 `deps.openSession` 回退全部移除：0.1.7-alpha.2 只有工作区服务这一个入口）。
   *
   * 入口只在「确实取到了 openSession 方法」时才算可用；属性读取抛错（未声明服务）、
   * 方法缺失、非函数一律按不可用处理。
   */
  function getOpenSession(deps, ctx) {
    const workspace = resolveClientService([deps, ctx, deps?.ctx], "uiWorkspace");
    const openWorkspaceSession = methodOf(workspace, "openSession");
    if (openWorkspaceSession !== null) {
      return {
        open: (target) => openWorkspaceSession.call(workspace, target),
        acceptsAddress: true,
        available: true,
      };
    }
    return { open: () => {}, acceptsAddress: false, available: false };
  }

  /** fan-out 管理状态：只用于取消/重试判定与 data-task-status，不作为展示状态词。 */
  function statusOf(node) {
    const value = text(object(node).status, "unknown");
    return value || "unknown";
  }

  /**
   * 规范运行状态（展示与图标唯一使用的状态）。
   * 模型可用时由模型按官方源字段归一，模型缺失时才退回可证明的 running 布尔。
   */
  function runtimeStatusOf(node, entry) {
    const model = modelApi();
    if (typeof model.runtimeStatusOf === "function") return model.runtimeStatusOf(node, entry);
    return object(node).running === true ? "running" : "ready";
  }

  /**
   * 官方目录项的查找表工厂：把会话投影 `projectionsBySession[parentId].values.subagentCatalog`
   * 预建为 parentId → (childId → entry) 的两级 Map，消除「每渲染一行就线性扫描一次目录」的成本
   * （大列表下渲染成本曾随条目数线性放大）。
   *
   * 0.1.7-alpha.2 的目录项只保证身份类字段（id / createdAt / mode / label），**不再带 activity**：
   * 「这个子代理是否在运行」必须从 byId 投影的 `SessionSummary.running` 派生（与 DSH 原生
   * 子代理目录同一算法）。因此这里在不改变其他字段的前提下补一个 activity：
   * - 目录项自带合法 activity（running/inactive）时原样保留，不覆盖更强证据；
   * - 否则用 byId 的布尔 running 派生 running/inactive；
   * - byId 也没有布尔 running 时保持缺失，由模型的活动证据链继续回退到 DEG 元数据，
   *   绝不把未知猜成「未运行」。
   * 任务标题与元数据仍只在渲染层从 byId 与 DEG 元数据读取，本表不产出展示文案。
   *
   * 逐条对齐旧线性扫描的语义，保证渲染行为零变化：
   * - 目录缺失、非数组、投影快照形状不符时按空目录处理（查不到任何条目）；
   * - id 取 entry.id，缺失时回退 entry.sessionId，且沿用 text() 的去空白口径；
   * - 重复 id 保留**第一个**匹配项（旧扫描在首处匹配即返回）；
   * - 每个 parentId 的桶按需构建一次并缓存在闭包里：同一帧内同一父节点的所有行共用
   *   同一份表，整帧的总成本从 O(行数 × 条目数) 降到 O(条目数)。
   */
  function createCatalogLookup(snapshot) {
    const tables = new Map();
    const tableFor = (parentId) => {
      const cached = tables.get(parentId);
      if (cached !== undefined) return cached;
      const table = new Map();
      const projection = object(object(object(snapshot).projectionsBySession)[parentId]);
      const values = object(projection.values);
      const entries = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
      for (const entry of entries) {
        const source = object(entry);
        if (source.kind === "diagnostic") continue;
        const id = text(source.id, text(source.sessionId, null));
        // 先到先得：与旧的「首个匹配即返回」保持同序同结果。
        if (id !== null && !table.has(id)) table.set(id, withSessionActivity(source, snapshot, id));
      }
      tables.set(parentId, table);
      return table;
    };
    return (parentId, childId) => {
      if (parentId === null || childId === null) return null;
      const table = tableFor(parentId);
      return table.has(childId) ? table.get(childId) : null;
    };
  }

  /** 目录 activity 的两个规范值（0.1.7-alpha.2 的目录投影不再携带，由 byId 的 running 派生）。 */
  const CATALOG_ACTIVITIES = new Set(["running", "inactive"]);

  /**
   * 给目录项补上活动证据：目录自带合法 activity 时原样返回，否则从 byId 的布尔 running 派生。
   * 两处证据都没有时返回原对象（保持「未知」，交由模型的活动证据链继续回退）。
   */
  function withSessionActivity(entry, snapshot, sessionId) {
    if (CATALOG_ACTIVITIES.has(text(entry.activity, null)) === true) return entry;
    const running = sessionRunningOf(snapshot, sessionId);
    if (running === null) return entry;
    return { ...entry, activity: running ? "running" : "inactive" };
  }

  /**
   * 权威会话标题：只接受 sessions 快照的 byId[id].title。
   * displayTitle 会在没有标题时回落到 session id，因此绝不拿它当标题文案。
   */
  function authoritativeTitleOf(snapshot, sessionId) {
    if (sessionId === null) return null;
    const summary = object(object(object(snapshot).byId)[sessionId]);
    return text(summary.title, null);
  }

  /**
   * byId 投影里的会话运行状态（官方活动轴）。
   *
   * 0.1.7-alpha.2 的子代理目录投影只保证身份类字段（id/createdAt/mode/label），不再携带
   * activity，因此「这个子代理是否在运行」必须从 byId 投影的 SessionSummary.running 读取；
   * 非布尔（快照缺失、字段缺失）返回 null，调用方继续回退到 DEG 自己的元数据证据。
   */
  function sessionRunningOf(snapshot, sessionId) {
    if (sessionId === null) return null;
    const summary = object(object(object(snapshot).byId)[sessionId]);
    return typeof summary.running === "boolean" ? summary.running : null;
  }

  /**
   * 第三行动态摘要：模型可用时复用 DSH 原生代理行的同源组合，否则只保留权威标题。
   * 根节点是导航树入口，不代表可恢复的专家执行，因此明确省略 mode，只保留 title/activity。
   */
  function agentSummaryOf(node, entry, title) {
    const model = modelApi();
    if (typeof model.formatAgentSummary === "function") {
      const source = object(node);
      if (source.kind === "root") {
        // 不改变普通专家的 mode 语义；root-only 副本同时屏蔽目录 mode 与 continuable 回退。
        const rootEntry = entry === null || entry === undefined ? entry : { ...object(entry), mode: undefined };
        const rootNode = { ...source, continuable: undefined };
        return model.formatAgentSummary({ title, entry: rootEntry, node: rootNode });
      }
      return model.formatAgentSummary({ title, entry, node });
    }
    return text(title, "");
  }

  function metadataOf(node) {
    const model = modelApi();
    if (typeof model.formatExpertMetadata === "function") return model.formatExpertMetadata(node);
    const source = object(node);
    return [text(source.role, source.kind === "root" ? "Orchestrator" : "Expert"), text(source.provider, "未知供应商"), text(source.model, "未知模型"), text(source.effort, "默认")].join(" · ");
  }

  /**
   * 第一行文案。
   *
   * - 根节点固定为中文「主代理」：绝不显示 root taskName/title/displayTitle/session id，
   *   也不接受任何 session- 前缀回退；根会话的权威标题只出现在第三行摘要里。
   * - 普通专家节点继续显示 Host 投影的最新 dispatch 短描述（context.label /
   *   lastDispatch.description / 冷会话标题），重复 dispatch 后即为最新描述。
   * - fan-out 分支标题保留 role、分片数与规范运行状态词。
   */
  function titleOf(node) {
    const source = object(node);
    if (source.kind === "fanout") {
      const role = text(source.role, "Expert");
      const count = Array.isArray(source.shards) ? source.shards.length : 0;
      return role.charAt(0).toUpperCase() + role.slice(1) + " · " + count + " shards · " + RUNTIME_STATUS_LABELS[runtimeStatusOf(source, null)];
    }
    if (source.kind === "root") return "主代理";
    return text(source.taskName, "未命名任务");
  }

  /**
   * 具名图标（仅用于折叠箭头与 fan-out 取消/重试动作）。
   *
   * 图标词表按 0.1.7-alpha.2 契约：后缀编码**描边粗细**（`*Regular` = 1px，`*Medium` = 1.3px），
   * 渲染尺寸由 `size` prop 承载；旧的 `*14` / `*16` 后缀名在该版本已全部消失。
   * 这里的 IconWarningOutlineRegular 只是「具名图标缺失」时的通用兜底图标，
   * 与代理运行状态无关：运行状态只由 StateDot 表达。
   * 兜底名本身也必须是 alpha.2 存在的导出，否则 `createElement(undefined)` 照样会渲染报错。
   */
  function makeIcon(primitives, name, props) {
    const Icon = primitives?.[name] || primitives?.IconWarningOutlineRegular;
    return typeof Icon === "function" ? Icon(props || { size: 14 }) : null;
  }

  /**
   * DEG 品牌图标组件（双人 users 图标）：better tab 与原生 guide 卡片共用同一个组件。
   *
   * 解析顺序刻意是「宿主优先、内联回落」：
   * 1. 宿主 primitives 导出了 IconUsersOutlineRegular 时直接用它——官方 artwork 将来改稿，
   *    插件自动跟随，不需要同步维护第二份形状定义；
   * 2. 该导出缺失（旧宿主 / 本包依赖的 alpha.2）时，用同一组 BRAND_ICON_PATHS 构造等价组件，
   *    保证任何宿主版本下看到的都是同一个图标；
   * 3. react 不可用（契约外直载安装）时返回 null；调用方据此整条 icon 字段都不写，
   *    注册契约的其余部分逐字节不变，install 绝不因缺依赖抛错。
   *
   * props 只消费 `size` 与 `className`（与宿主 IconProps 一致）：尺寸由调用方注入，插件的
   * 内联组件不固定渲染尺寸，也不引入第二套描边粗细。
   */
  function createBrandIcon(react, primitives) {
    if (typeof primitives?.IconUsersOutlineRegular === "function") return primitives.IconUsersOutlineRegular;
    if (typeof react?.createElement !== "function") return null;
    return function DegBrandIcon(props) {
      const size = props?.size ?? 16;
      // 4 条 path 逐条作为独立 child 传入（而不是传一个数组）：真实 React 与测试替身看到的
      // 子节点形状一致，断言「4 条 path」时不需要额外展平；key 用 path 数据本身，
      // 四条 d 互不相同，重渲染时不会错位复用。
      return react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        className: props?.className,
        "aria-hidden": "true",
        strokeWidth: 1,
        xmlns: "http://www.w3.org/2000/svg",
      }, ...BRAND_ICON_PATHS.map((d) => react.createElement("path", {
        key: d,
        d,
        stroke: "currentColor",
        fill: "none",
      })));
    };
  }

  /**
   * 状态圆点：优先使用注入的官方 primitives.StateDot。
   * running → state:ongoing（DSH 原生 1 秒追逐动画），ready → state:done（绿色静态圆点）。
   * 只有官方组件不可用时才退化为无动画的静态圆点——插件不复制也不改写原生动画。
   */
  function stateDotOf(react, primitives, status) {
    const StateDot = primitives?.StateDot;
    if (typeof StateDot === "function") {
      return react.createElement(StateDot, { state: RUNTIME_STATE_DOT[status] || RUNTIME_STATE_DOT.ready });
    }
    return react.createElement("span", {
      className: "deg_expert_group_state_dot",
      "data-state": status,
      "aria-hidden": "true",
    });
  }

  /** 状态图标：外层 span 承担无障碍名称，内容始终是规范运行状态的圆点。 */
  function statusIcon(react, primitives, status) {
    const label = RUNTIME_STATUS_LABELS[status] || RUNTIME_STATUS_LABELS.ready;
    return react.createElement("span", {
      className: "deg_expert_group_status_icon",
      role: "img",
      "aria-label": label,
      title: label,
      "data-status": status,
    }, stateDotOf(react, primitives, status));
  }

  function safeNormalize(raw) {
    const model = modelApi();
    if (typeof model.normalizeExpertGroupSnapshot !== "function") return null;
    try { return model.normalizeExpertGroupSnapshot(raw); } catch { return null; }
  }

  /**
   * 结构相等比较（只用于上屏内容的「有没有真的变化」判定）。
   *
   * 输入是 normalizeExpertGroupSnapshot 逐字段重建出来的纯数据：只有原始值、数组与普通对象，
   * 无函数、无循环引用，因此不需要序列化，也不需要防环弱表。
   *
   * 实现刻意做到「无分配 + 第一处不同即早退」：空闲轮询的典型输入是整棵树完全相同，此时
   * 只做一次遍历、不产生任何中间对象；一旦真有变化（通常发生在树的浅层），比较立刻返回 false，
   * 把成本降到常数级。旧实现每次都把响应当作变化、整树重新渲染，这才是热点。
   */
  function snapshotContentEquals(left, right) {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (Array.isArray(left) !== Array.isArray(right) || left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (snapshotContentEquals(left[index], right[index]) !== true) return false;
      }
      return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (Object.prototype.hasOwnProperty.call(right, key) !== true) return false;
      if (snapshotContentEquals(left[key], right[key]) !== true) return false;
    }
    return true;
  }

  /**
   * 两次归一化快照「上屏内容」是否等价。
   *
   * 只比较真正影响渲染的部分：schemaVersion、sessionId、rootSessionId 与 root 子树。
   * 顶层 generatedAt 必须显式忽略——Host 每次响应都填新的 Date.now()，把它算进比较等于
   * 「每次轮询都是新内容」，内容比较就彻底失效，也就回到了每次全树重渲染。
   *
   * 比较方向是单向的：内容相等 ⇒ 不更新状态；内容不等 ⇒ 一定更新，绝不吞掉真实变化。
   */
  function samePanelSnapshot(left, right) {
    if (left === right) return true;
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return left.schemaVersion === right.schemaVersion
      && left.sessionId === right.sessionId
      && left.rootSessionId === right.rootSessionId
      && snapshotContentEquals(left.root, right.root);
  }

  /**
   * 注入侧声明 RPC adapter 协议的字段名。
   *
   * 历史实现按被调用函数的 `length >= 2` 猜测 adapter 是 connection-first 还是 request-first：
   * 默认参数、rest 参数、bind 与 wrapper 都会改变 `Function.length`（例如
   * `(...args) => base(...args)` 的 length 是 0），判定会因此翻到错误的一侧。
   * 现在协议只能由注入侧显式声明，判定完全不读取被调用函数的形态。
   */
  const RPC_ADAPTER_PROTOCOL_FIELD = "rpcAdapterProtocol";
  /**
   * RPC adapter 的三种合法调用约定。
   *
   * - object：新公开契约 `fn({ connection, request, init })`，参数含义与顺序无关；
   * - connection-first：v1 契约 `fn(connection, request, init)`，本插件长期注入的形状，
   *   也是未声明协议时的默认兼容边界；
   * - request-first：v1 的另一种最小约定 `fn(request, connection, init)`。它在旧实现里
   *   只能靠 arity 猜出来，现在必须由注入侧显式声明才生效。
   */
  const RPC_ADAPTER_PROTOCOLS = Object.freeze({
    object: "object",
    "connection-first": "connection-first",
    "request-first": "request-first",
  });

  /**
   * 解析当前注入的 RPC adapter 协议。
   *
   * 协议判定的唯一来源是注入侧（deps）的显式声明，因此默认参数、rest、bind、wrapper
   * 以及任何函数形态变化都不可能改变调用约定。
   *
   * 兼容边界：未声明（缺字段、null、空串或纯空白）按 v1 的 connection-first 调用——
   * client.js 注入的 requestPluginRpc 正是这个形状，历史宿主不需要任何改动。需要
   * request-first 或对象参数的历史/新 adapter 必须显式声明。
   *
   * 声明了未知协议时 fail-closed 抛出明确错误，绝不回落到猜测：静默按错误的参数顺序
   * 调用会得到难以定位的传输层错误，明确拒绝才能让宿主立刻发现问题。
   */
  function rpcAdapterProtocolOf(deps) {
    const declared = deps?.[RPC_ADAPTER_PROTOCOL_FIELD];
    if (declared === undefined || declared === null || declared === "") return RPC_ADAPTER_PROTOCOLS["connection-first"];
    if (typeof declared !== "string") throw new TypeError("RPC adapter 协议标识必须是字符串");
    const protocol = declared.trim();
    if (protocol === "") return RPC_ADAPTER_PROTOCOLS["connection-first"];
    if (protocol === RPC_ADAPTER_PROTOCOLS.object
      || protocol === RPC_ADAPTER_PROTOCOLS["connection-first"]
      || protocol === RPC_ADAPTER_PROTOCOLS["request-first"]) return protocol;
    throw new Error("未知的 RPC adapter 协议：" + protocol);
  }

  /**
   * 按声明的协议组装调用实参。
   *
   * init 必须原样透传：adapter 依赖它把 AbortSignal 交给 Connection 或同源 fetch，
   * 也依赖它决定两条传输的 error/envelope 语义。
   */
  function rpcAdapterArguments(protocol, ctx, request, init) {
    const connection = ctx?.connection;
    if (protocol === RPC_ADAPTER_PROTOCOLS.object) return [{ connection, request, init }];
    if (protocol === RPC_ADAPTER_PROTOCOLS["request-first"]) return [request, connection, init];
    return [connection, request, init];
  }

  async function callRpc(deps, ctx, request, init = {}) {
    const fn = deps.requestPluginRpc;
    if (typeof fn !== "function") throw new Error("当前 DSH 未提供插件 RPC");
    const protocol = rpcAdapterProtocolOf(deps);
    const response = await fn(...rpcAdapterArguments(protocol, ctx, request, init));
    if (response?.ok === false) throw new Error(text(response.error?.message, "RPC 请求失败"));
    if (typeof response?.json === "function") {
      const payload = await response.json();
      if (payload?.ok === false) throw new Error(text(payload.error?.message, "RPC 请求失败"));
      const body = payload?.value ?? payload;
      return body?.snapshot ?? body;
    }
    if (response?.value !== undefined) return response.value?.snapshot ?? response.value;
    return response?.snapshot ?? response;
  }

  function styleTag() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (document.querySelector?.("style[data-plugin-css=\"" + STYLE_ID + "\"]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-expert-group";
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = [
      ".deg_expert_group{display:flex;flex-direction:column;min-width:0;height:100%;overflow:auto;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);font-size:12px;line-height:16px}",
      ".deg_expert_group_header{display:flex;align-items:center;min-height:28px;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}",
      ".deg_expert_group_header_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".deg_expert_group_header_action,.deg_expert_group_chevron,.deg_expert_group_action,.deg_expert_group_sidebar_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".deg_expert_group_header_action{width:24px;height:24px;margin-left:auto}",
      // 标题栏 Auto 开关：紧凑到与标题同一行，右对齐且不换行，绝不遮挡标题或右侧操作按钮。
      ".deg_expert_group_header_auto{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:8px;font-weight:400;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
      ".deg_expert_group_header_auto_input{margin:0;cursor:pointer}",
      ".deg_expert_group_header_auto_input:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_header_auto_label{font-size:12px;line-height:16px}",
      ".deg_expert_group_header_action:hover,.deg_expert_group_chevron:hover,.deg_expert_group_action:hover:not(:disabled),.deg_expert_group_sidebar_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".deg_expert_group_header_action:focus-visible,.deg_expert_group_chevron:focus-visible,.deg_expert_group_action:focus-visible,.deg_expert_group_sidebar_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_tree{min-width:0;padding-top:5px}",
      ".deg_expert_group_node{position:relative;min-width:0;padding-left:16px}",
      ".deg_expert_group_node_root{padding-left:0}",
      ".deg_expert_group_row{box-sizing:border-box;display:grid;grid-template-columns:20px 20px minmax(0,1fr);min-width:0;height:60px;min-height:60px;padding:4px 0}",
      // 第一行必须是 auto：默认单行 16px 时与旧布局逐像素相同；分片第一行换行时按内容撑高，
      // 绝不把多行文本压进 16px 行盒而与第二行重叠——它没有省略号语义（见 .deg_expert_group_shard_task）。
      // 第二、三行保持 16px 是因为省略号只在单行行盒上生效：行盒被内容撑开时 WebKit/Blink 会退化成
      // 裁切而不是显示 "…"，原生右栏与项目既有行为都以 "…" 结尾。
      ".deg_expert_group_row_main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 16px 16px;min-width:0}",
      // 第一行使用独立的内联容器：任务文字按内容宽度收缩，箭头紧跟在文字后方；名称过长时文字
      // 只在箭头前的可用空间内省略，不会把箭头推出右栏视口。第一行仍由内容撑高，兼容分片任务名换行。
      ".deg_expert_group_task_line{grid-area:1 / 1;display:flex;align-items:center;min-width:0;gap:2px}",
      ".deg_expert_group_meta{grid-area:2 / 1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}",
      // 两枚 20px chevron 重叠 10px，总宽 30px；按钮同步预留空间，避免箭头覆盖标题。
      ".deg_expert_group_sidebar_action{flex:0 0 30px;width:30px;height:20px;margin:-2px 0;padding:0;color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
      ".deg_expert_group_sidebar_action:hover{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
      // 打开态（可关闭的 <<）：同一枚按钮换成主题 business/info 色，缺 token 的老宿主退回 cyan。
      // 属性选择器 + 类选择器的特异度高于共享 hover 规则，因此这里显式重复 hover：「已打开」的
      // 身份色在悬停时同样保持；键盘聚焦沿用共享 focus-visible 的 outline（它不设置颜色），
      // 颜色因此仍是打开态的青色，聚焦轮廓与颜色同时可读。
      ".deg_expert_group_sidebar_action[data-open=true]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_action[data-open=true]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_double_arrow{display:inline-flex;align-items:center;justify-content:center;width:30px;height:20px;line-height:0}",
      ".deg_expert_group_double_arrow>*+*{margin-left:-10px}",
      ".deg_expert_group_double_arrow_icon path{stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}",
      ".deg_expert_group_line{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".deg_expert_group_task{min-width:0;flex:0 1 auto;font-weight:600;cursor:pointer}",
      // fan-out 分片第一行是「分片代号  任务名称」：代号已经占掉单行相当一部分宽度，
      // 继续按单行省略会让任务名称几乎不可读。这里改成可换行：完整文本按行折行展示，
      // overflow-wrap:anywhere 让超长且无分隔符的名称（中文长句、长英文标识）也能折行，
      // 绝不溢出到第二、三行或右侧的取消/重试按钮下面。行高由内容撑开（.deg_expert_group_shard
      // 只设 min-height），因此名称越长行越高而不是被裁掉。
      ".deg_expert_group_shard_task{overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}",
      ".deg_expert_group_task:hover,.deg_expert_group_content:hover{text-decoration:underline}",
      ".deg_expert_group_content{grid-area:3 / 1;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}",
      ".deg_expert_group_chevron{width:20px;height:20px;padding:0;align-self:start}",
      ".deg_expert_group_fanout_header>.deg_expert_group_chevron{align-self:center}",
      ".deg_expert_group_chevron_placeholder{display:inline-block;width:20px;height:20px}",
      ".deg_expert_group_status_icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}",
      // 兜底圆点：官方 primitives.StateDot 缺失时才使用，静态、无动画。
      ".deg_expert_group_state_dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".deg_expert_group_state_dot[data-state=running]{color:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary))}",
      ".deg_expert_group_state_dot[data-state=ready]{color:var(--dsw-alias-state-success-primary)}",
      // 固定 30px 批量控件紧跟标题文字；不占独立 grid 尾列，也不使用自动外边距推向行尾。
      // 标题自身 min-width:0 + 单行省略，窄宽度下只收缩文字，箭头与批量控件保持固定占位。
      ".deg_expert_group_trailing{display:flex;flex:0 0 30px;align-items:center;justify-content:center;width:30px;height:20px;min-width:30px}",
      ".deg_expert_group_task_line_trailing{justify-content:flex-start}",
      ".deg_expert_group_idle_title_line{display:flex;align-items:center;min-width:0;gap:2px}",
      ".deg_expert_group_idle_title_line>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
      // 批量关闭按钮：与单会话箭头同尺寸（30×20）与同色系（主题 business/info，缺 token 退回 cyan），
      // 形状是同一枚「两个左尖括号」图标。pending 期间 disabled + aria-busy，绝不重复发出关闭序列。
      ".deg_expert_group_sidebar_batch_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 30px;width:30px;height:20px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_batch_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_batch_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_sidebar_batch_action:disabled{opacity:.45;cursor:wait}",
      // 「零」占位：inventory 已知为空时的非交互蓝色实心圆（直径 12px）。它只占位：
      // 没有 button / hover / tabindex，不进入键盘与可访问性交互面。
      ".deg_expert_group_sidebar_batch_zero{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary,#22d3ee))}",
      // 树线锚点固定在每一级父行的 20px 状态列中心，避免依赖窗口测量。
      ".deg_expert_group_children{position:relative;min-width:0;margin:0;padding:0;--deg-parent-row-height:60px}",
      ".deg_expert_group_children>.deg_expert_group_node,.deg_expert_group_children>.deg_expert_group_fanout,.deg_expert_group_children>.deg_expert_group_idle_group{--deg-tree-anchor:14px;position:relative}",
      ".deg_expert_group_children>.deg_expert_group_fanout{--deg-tree-anchor:14px}",
      ".deg_expert_group_children>:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_children>:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",

      ".deg_expert_group_node>.deg_expert_group_row,.deg_expert_group_fanout_header,.deg_expert_group_idle_group>.deg_expert_group_row{position:relative}",
      ".deg_expert_group_node:not(.deg_expert_group_node_root)>.deg_expert_group_row:before,.deg_expert_group_fanout_header:before,.deg_expert_group_idle_group>.deg_expert_group_row:before{position:absolute;top:var(--deg-tree-anchor,14px);left:-6px;width:16px;border-top:1px solid var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_row>*,.deg_expert_group_fanout_header>*{position:relative;z-index:1}",
      // 空闲分组没有隐式首项 spacer；折叠、展开和空列表都保持直接相邻。
      ".deg_expert_group_idle_group{position:relative;min-width:0;padding-left:16px;--deg-tree-anchor:14px}",
      ".deg_expert_group_idle_group>.deg_expert_group_children{margin:0;padding:0;--deg-parent-row-height:28px}",
      // 空闲分组标题行同样是 grid：状态列 + chevron 列 + 可收缩标题列 + 批量 trailing slot。
      // 第四列用 auto（与 .deg_expert_group_fanout_header 的 actions 列同款）：slot 存在时按它自己的
      // 30px 宽占位，slot 为空（没有批量能力）时该列宽度为 0——标题宽度因此与改动前逐像素一致，
      // 绝不会因为「能力缺失」而平白被压掉 30px。空 idleChildren 时该 slot 承载不可交互的零圆点。
      ".deg_expert_group_idle_group>.deg_expert_group_row.deg_expert_group_idle_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr);align-items:center;height:28px;min-height:28px;padding:4px 0}",
      ".deg_expert_group_idle_group>.deg_expert_group_row{margin:0}",
      ".deg_expert_group_fanout{position:relative;margin-top:0;padding-left:16px}",
      ".deg_expert_group_fanout_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;align-items:center;min-width:0;min-height:28px;gap:4px}",
      ".deg_expert_group_fanout_shards{position:relative;min-width:0;--deg-parent-row-height:28px}",
      // 分片第一行可以换行，行高不再固定 48px，所以树线锚点绑定到**固定 20px 高**的状态图标
      // 中心（3px 上内边距 + 10px），而不是行高的一半：水平连接线与垂直树线继续对准状态列，
      // 多行名称只让行变高，树形结构与高度语义不受影响。
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard{--deg-tree-anchor:13px;position:relative}",
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_shard{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;min-width:0;min-height:48px;padding:3px 0;gap:0 3px}",
      ".deg_expert_group_shard[data-expanded=false]{min-height:24px}",
      ".deg_expert_group_actions{display:flex;align-items:flex-start;gap:2px}",
      ".deg_expert_group_action{width:24px;height:24px;padding:0}",
      ".deg_expert_group_action:disabled{opacity:.45;cursor:wait}",
      ".deg_expert_group_empty{padding:16px 2px;color:var(--dsw-alias-label-secondary)}",
      ".deg_expert_group_skeleton{height:52px;margin:4px 0;border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));opacity:.65}",
      ".deg_expert_group_error{display:flex;align-items:center;gap:4px;padding:6px 0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:11px}",
      ".deg_expert_group_count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}",
    ].join("");
    document.head?.appendChild(tag);
  }

  /**
   * 宿主 AppFrame 右栏拖拽手柄的稳定公开标记（div[data-side="rightbar"]）。
   *
   * 宿主 AppFrame 的 DragHandle 渲染成 <div class="…handle" data-side={props.side}>，右栏那一枚
   * 的 side 就是 "rightbar"（左栏是 "sidebar"）；它只在「右栏已展开 + 非全屏 + 宽度大于 0」时
   * 出现，是用户拖拽改变右栏宽度的**唯一**入口（pointerdown → setPointerCapture → setRightbar）。
   * 属性名与取值都是宿主自己写死的公开标记，插件只读它、绝不改写宿主 DOM 结构。
   */
  const RIGHTBAR_DRAG_HANDLE_SELECTOR = "[data-side=rightbar]";

  /**
   * 读取一个节点的属性原文；读不到（没有 getAttribute、抛错、返回非字符串）返回 null。
   *
   * 一律不抛：属性读面缺失与属性缺失在这里是同一件事——调用方只允许按「读不出来」fail-closed，
   * 绝不允许猜一个默认值。
   */
  function attributeOf(node, name) {
    try {
      if (node === null || node === undefined || typeof node.getAttribute !== "function") return null;
      const raw = node.getAttribute(name);
      return typeof raw === "string" ? raw : null;
    } catch { return null; }
  }

  /**
   * 判断 node 是否与 root 处在**同一个 dock 作用域**内（父链上不跨过 boundaries 里的任一个标记）。
   *
   * 用途：右栏一列的内容区里可能嵌着另一个完整 dock（它有自己的 host/split 与 tab 条），
   * 那种 tab 属于嵌套页面，不能算进当前列。判定从 node 的父节点一路走到 root（不含 root 自身）：
   * 途中遇到任何 boundary 标记就返回 false。
   * 返回三态：true＝同作用域，false＝跨了作用域，null＝父链/属性读面不可用（调用方 fail-closed）。
   */
  function withinSameDockScope(node, root, boundaries) {
    let parent = null;
    try { parent = node?.parentNode ?? null; } catch { return null; }
    let guard = 0;
    while (parent !== null && parent !== undefined && parent !== root) {
      guard += 1;
      if (guard > 512) return null;
      if (typeof parent.getAttribute !== "function") return null;
      for (const name of boundaries) {
        if (attributeOf(parent, name) !== null) return false;
      }
      try { parent = parent.parentNode ?? null; } catch { return null; }
    }
    return parent === root;
  }

  /**
   * 读一个 dock host 的 DOM 布尔 `hidden`。
   *
   * 真实 DockLayout（app.asar 里 US 组件渲染 host 的那一处）写的是 React 的 `hidden: !w`，
   * 其中 w = 「这个 host 的 tab 就是它所属 pane 的 activeTabId」：同一 pane 只有**一个** host
   * 不带 hidden，其余 host 全部带 hidden。hidden 是 HTMLElement 的布尔 IDL 属性，因此这里只认
   * 真正的布尔值；属性读面缺失、抛错或返回非布尔（替身没实现、宿主换了渲染方式）一律返回 null，
   * 调用方按「读不出来」fail-closed，绝不把 undefined 当成「可见」。
   */
  function hostHiddenStateOf(host) {
    try {
      const value = host?.hidden;
      return typeof value === "boolean" ? value : null;
    } catch { return null; }
  }

  /**
   * 读取一个 dock **逻辑列**（= 同一 data-dockkit-column 下的全部 host）的**唯一活跃 tab 条**。
   *
   * 真实 DockLayout 对**每个 tab** 渲染一个 div[data-dockkit-host="dock"]，同一 pane 的多个 tab
   * 共享同一个 data-dockkit-column；而 tab 条本身**只挂在活跃 tab 的那个 host 上**：
   *   hidden: !w                            ← 非活跃 host 带 DOM hidden
   *   children: [ w && <TabStrip …/>, … ]   ← 非活跃 host 连 strip 都不渲染
   * 活跃 host 的那条 strip 里列出的是**该 pane 的全部 tab**（TabStrip 渲染 pane.tabs），所以只要
   * 取到唯一活跃 strip，这一逻辑列的 tab 组成就是完整的——多开一个子代理 tab 只会多出一个
   * hidden 的空 host，绝不能让整列因此变成「读不出来」而退回宿主的 1:1。
   *
   * 判定（任一条不成立即整列 fail-closed，绝不猜）：
   * - 每个 host 的 hidden 必须是可读的布尔值；
   * - hidden === true 且该 host 没有自己的 strip → 真实非活跃 host，跳过；
   * - hidden === false 且**恰好一条**自己的 strip → 活跃 host，收集这条 strip；
   * - 可见 host 没有 strip、hidden host 却带着自己的 strip、querySelectorAll 或父链读面抛错
   *   → 结构不是本插件认识的那一种，fail-closed；
   * - 一个逻辑列出现多个活跃 strip host，或整列一个活跃 strip 都没有 → fail-closed。
   *
   * 列内容区里嵌着的另一个 dock 也有自己的 strip，靠 withinSameDockScope 排除（父链上跨过
   * host/split 的 strip 不算本列）。返回 null 表示读不出来；可读时返回**恰好一条** strip 的数组。
   */
  function cellStripNodesOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return null;
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return null;
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return null;
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return null; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return null;
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；它若带着自己的 tab 条，说明结构不是这一种，fail-closed。
        if (owned.length !== 0) return null;
        continue;
      }
      // 可见 host 必须恰好有一条自己的 tab 条：零条（tab 条没渲染出来）或多条都无法证明组成。
      if (owned.length !== 1) return null;
      activeCount += 1;
      if (activeCount > 1) return null;
      activeStrip = owned[0];
    }
    // 整列必须恰好一个活跃 host：整列全 hidden（一条 strip 都没有）同样读不出组成。
    if (activeCount !== 1 || activeStrip === null) return null;
    return [activeStrip];
  }

  /**
   * 读取一个逻辑列自己的 tabId 集合。
   *
   * 只认**唯一活跃 strip** 里的 tab 芯片（strip 内部更深一层的 strip 属于嵌套 dock，不算本列）。
   * 读面抛错、活跃 strip 不是恰好一条、strip 里没有任何 tab、未知或空 tabId 都让整列读不出来，
   * 调用方据此 fail-closed，绝不把「读不到」当成空列。
   *
   * 同一条 strip 里出现重复 tabId 同样是结构异常（一个 tab 不可能在同一个 tablist 里出现两次）：
   * 这里绝不能用 Set 静默吞掉重复，否则「读面不完整」会被误判成正常组成。
   */
  function cellTabIdsOf(column) {
    const ids = new Set();
    const strips = cellStripNodesOf(column);
    // 读面契约：可读时恰好一条活跃 strip；null 或长度不为 1 都表示这一列读不出来。
    if (strips === null || strips.length !== 1) return { ids, readable: false };
    const strip = strips[0];
    if (typeof strip.querySelectorAll !== "function") return { ids, readable: false };
    let tabNodes = null;
    try { tabNodes = Array.from(strip.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return { ids, readable: false }; }
    for (const node of tabNodes) {
      const scoped = withinSameDockScope(node, strip, [RIGHTBAR_STRIP_TABS_ATTRIBUTE]);
      if (scoped === null) return { ids, readable: false };
      if (scoped !== true) continue;
      const tabId = text(attributeOf(node, RIGHTBAR_TAB_ID_ATTRIBUTE), null);
      if (tabId === null) return { ids, readable: false };
      if (ids.has(tabId)) return { ids, readable: false };
      ids.add(tabId);
    }
    if (ids.size === 0) return { ids, readable: false };
    return { ids, readable: true };
  }

  /**
   * Expert Group 的 tabId 集合（kind 规范化 + DockKit 生成的 id）。
   *
   * inventory 是公开只读读面（sidebarRight.openTabs.getSnapshot），可用时它把 kind 映射成真实
   * tabId（DockKit 生成的 `dsh-expert-group1` 这类 id 仍在集合里）；读面缺失/抛错/返回非数组时
   * 退回旧宿主里 kind 直接当 tabId 用的 DOM 形态，并由 isGeneratedExpertGroupTabId 继续识别
   * 计数器后缀。其它旧逻辑允许在 inventory 缺失时保留基础 kind 兼容集合；严格的分栏配比
   * 读面另用 sidebarTabSetsForSession（内部走 tabKindsForSession），只接受当前 session 的
   * inventory 归属。
   */
  function expertGroupTabIdsOf(inventory, sessionId) {
    const expertTabIds = new Set(EXPERT_GROUP_TAB_IDS);
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return expertTabIds;
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId !== null) expertTabIds.add(tabId);
      } catch {
        // 单条 inventory 记录损坏时跳过它，不能阻断其它 tab 的 pane 定位。
      }
    }
    return expertTabIds;
  }

  /**
   * 面板里的全部 dock pane 节点（顺序保留用于诊断，方向以 data-dockkit-column 为准）。
   *
   * 读不到（没有 querySelectorAll、查询抛错）时返回 null：调用方按「这一轮 pane 读面不可用」
   * fail-closed，绝不把「读不到」当成「没有 pane」。
   */
  function paneNodesOf(panel) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
    try { return Array.from(panel.querySelectorAll(RIGHTBAR_PANE_SELECTOR)); } catch { return null; }
  }

  /**
   * 只建立当前 session 的 tabId -> kind 映射。inventory 缺失、session 无效或同一 tabId 出现
   * 冲突 kind 时返回 null；配比路径不能用全局 kind 或生成式 id 猜测旧 pane 的归属。
   */
  function tabKindsForSession(inventory, sessionId) {
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return null;
    const tabKinds = new Map();
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        const tabId = text(candidate.tabId, null);
        const kind = text(candidate.kind, text(candidate.type, null));
        if (tabId === null || kind === null) continue;
        const previous = tabKinds.get(tabId);
        if (previous !== undefined && previous !== kind) return null;
        tabKinds.set(tabId, kind);
      } catch {
        // 单条损坏记录不参与映射；若 DOM 仍引用它，后续会按未知归属 fail-closed。
      }
    }
    return tabKinds;
  }

  /**
   * 当前 session 的 tabId 读面：expert = Expert Group 页的 id 集合；known = 本会话全部已知 tabId。
   *
   * 沿用 tabKindsForSession 的严格归属：inventory 读不出来、session 无效、同一 tabId 出现冲突
   * kind 时返回 null（调用方整体 fail-closed），绝不退回全局 kind 或用生成式 id 猜测归属。
   * 静态 EXPERT_GROUP_TAB_IDS 作为旧宿主（kind 直接当 tabId）的兼容基线同时进入两个集合。
   */
  function sidebarTabSetsForSession(inventory, sessionId) {
    const tabKinds = tabKindsForSession(inventory, sessionId);
    if (tabKinds === null) return null;
    const expert = new Set(EXPERT_GROUP_TAB_IDS);
    const known = new Set(EXPERT_GROUP_TAB_IDS);
    for (const [tabId, kind] of tabKinds) {
      known.add(tabId);
      if (EXPERT_GROUP_TAB_IDS.has(kind)) expert.add(tabId);
    }
    return { expert, known };
  }

  /**
   * 按 data-sidebar-right-session 精确挑选属于当前 surface 的右栏面板。
   *
   * 面板会迟到挂载、也可能在一次 surface 重挂载里同时留下新旧两个；`querySelector` 的第一个命中
   * 无法证明归属，因此这里要求面板自带会话归属标记并与本轮 session **完全相等**，而且全局恰好
   * 一个匹配（零个＝还没挂载或不属于这一页，多个＝归属不明确）。缺属性、读面不可用或有歧义
   * 都返回 null，调用方保持 fail-closed，绝不猜第一个面板。
   */
  function rightbarPanelForSession(doc, sessionId) {
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    if (typeof sessionId !== "string" || sessionId === "") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    let matched = null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== sessionId) continue;
      if (matched !== null) return null;
      matched = node;
    }
    return matched;
  }

  /**
   * 面板级读面（面板内的 tab/pane 观察与组成判定）共用的「当前 session 面板」解析入口。
   *
   * 第一判据与 rightbarPanelForSession 完全一致：面板自带 data-sidebar-right-session、与当前
   * session 完全相等、且全局唯一时才可用；零个（面板还没挂载 / 不属于这一页）或多个（归属不明确）
   * 都返回 null，调用方一律 fail-closed——绝不按 DOM 顺序取第一个面板，那正是跨 session 误命中的根因。
   *
   * 唯一的兼容分支是**旧宿主形状**：data-sidebar-right-session 出现之前的面板没有归属标记，
   * 此时 DOM 里读不到任何带标记的面板。只有这种「整轮都没有归属标记」的形状才退回 querySelector
   * 的旧读法，而且要求面板至多一个（多于一个＝归属不可能证明，直接 fail-closed）。只要出现过任何
   * 一个带标记的面板（现代宿主），这个分支整体失效：当前 session 自己的面板没挂载时保持 null，
   * 绝不拿别的 session 的面板顶替。
   */
  function rightbarPanelForSessionCompat(doc, sessionId) {
    const panel = rightbarPanelForSession(doc, sessionId);
    if (panel !== null) return panel;
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    // 归属标记一旦存在就不再兼容：多个面板、或任一面板带标记，都只能按精确归属判定。
    if (nodes.length > 1) return null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    }
    if (nodes.length === 1) return nodes[0];
    // 旧替身/旧宿主的读面形状：面板选择器只能通过 querySelector 命中。这里同样要求命中节点
    // 没有归属标记——带了标记说明它是别的 session 的面板，不能拿来顶替。
    if (typeof doc.querySelector !== "function") return null;
    let single = null;
    try { single = doc.querySelector(RIGHTBAR_PANEL_SELECTOR) ?? null; } catch { return null; }
    if (single === null || single === undefined) return null;
    if (attributeOf(single, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    return single;
  }

  /**
   * 读取 split 容器的直接 dock 列，并按列号归并成**逻辑列**。
   *
   * 只有 split 的**直接子节点**里 `data-dockkit-host="dock"` 且带非空 `data-dockkit-column`
   * 的才是真实列：浮动 host（data-dockkit-host="floating"）、resize 手柄、嵌套 split 的子列
   * 都不算列。列号缺失（读不出来或空串）一律整轮 fail-closed——拿不到列号的节点不能被当成一列。
   *
   * 真实 DockLayout 是「**每个 tab 一个 host**」：同一个 pane 的多个 tab 各有自己的
   * div[data-dockkit-host="dock"]，它们共享同一个 data-dockkit-column（只有活跃 tab 的那个 host
   * 不带 hidden、也只有它渲染 tab 条）。因此同列多个 host 是**合法**结构，这里按列号归并成
   * { column, hosts }：hosts 保留 DOM 顺序，顺序本身没有语义（组成判定只看活跃 strip 里的
   * tab 集合），列号到 host 的归属仍然是精确的。
   */
  function dockCellsOf(split) {
    const cells = [];
    let children = null;
    try { children = split?.children ?? null; } catch { children = null; }
    if (children === null || children === undefined) return { cells, readable: false };
    const byColumn = new Map();
    for (const child of Array.from(children)) {
      if (child === null || typeof child.getAttribute !== "function") return { cells, readable: false };
      if (attributeOf(child, RIGHTBAR_DOCK_HOST_ATTRIBUTE) !== RIGHTBAR_DOCK_HOST_VALUE) continue;
      const column = text(attributeOf(child, RIGHTBAR_PANE_COLUMN_ATTRIBUTE), null);
      if (column === null) return { cells, readable: false };
      const merged = byColumn.get(column);
      if (merged === undefined) byColumn.set(column, { column, hosts: [child] });
      else merged.hosts.push(child);
    }
    for (const entry of byColumn.values()) cells.push(entry);
    return { cells, readable: true };
  }

  /**
   * 判断一个 split 容器是不是「列 0 = Expert Group、列 1 = 当前 session 的另一个已知页」。
   *
   * fail-closed 的边界（任一条不成立就 false，插件一个字节都不写）：
   * - 归并后的逻辑列不是**恰好两列**，或列号不是精确的 0/1（三列、缺列、未知列号都没有可证明的 40:60）；
   * - 任一逻辑列读不出自己的活跃 strip / tabId（整列没有活跃 strip、多个活跃 strip、
   *   可见 host 没有 strip、hidden host 却带 strip、hidden 状态不可读、未知 tabId、读面抛错）；
   * - 列 0 里混进非 Expert Group 页，或列 1 里出现 Expert Group 页；
   * - 同一个 tabId 同时出现在两列，或同一条 strip 里重复出现（重复归属），
   *   或出现本会话 inventory 里没有的 tab（未知归属）。
   *
   * 同列多个 host（真实「每个 tab 一个 host」形态）本身合法：判定用的是归并后的逻辑列与它唯一的
   * 活跃 strip（该 strip 列出整个 pane 的 tab），因此多个子代理 tab 与单个子代理 tab 得到完全
   * 相同的 40:60 结论。
   */
  function splitOwnsExpertPair(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return false;
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return false;
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return false;
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    const otherTabs = cellTabIdsOf(byColumn.get("1"));
    if (expertTabs.readable !== true || otherTabs.readable !== true) return false;
    let expertCount = 0;
    for (const tabId of expertTabs.ids) {
      if (otherTabs.ids.has(tabId)) return false;
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) !== true) return false;
      expertCount += 1;
    }
    if (expertCount === 0) return false;
    for (const tabId of otherTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) === true) return false;
    }
    return true;
  }

  /**
   * 一个逻辑列的「暂不可读」判定（与 cellStripNodesOf 同一套读面，但区分失败原因）。
   *
   * 返回 "readable" | "unavailable" | "foreign"：
   * - "readable"：恰好一条活跃 tab 条且 tab 组成可读——这一列有完整组成，轮不到 pending 分支；
   * - "unavailable"：整列只有 hidden host（tab 条还没渲染出来）。这是重启恢复窗口里第二列的
   *   典型形状，只有这种形状才允许 pending；
   * - "foreign"：可见 host 没有 tab 条、非活跃 host 却带着自己的 tab 条、一个逻辑列出现多个活跃
   *   strip host、hidden 状态不可读、host 列表为空、读面抛错。这些都不是「还没读完」而是
   *   「结构不是本插件认识的那一种」，必须按原有 fail-closed 语义交还宿主。
   */
  function cellPendingStateOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return "foreign";
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return "foreign";
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return "foreign";
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return "foreign"; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return "foreign";
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；带了自己的 tab 条说明结构不是这一种。
        if (owned.length !== 0) return "foreign";
        continue;
      }
      if (owned.length !== 1) return "foreign";
      activeCount += 1;
      if (activeCount > 1) return "foreign";
      activeStrip = owned[0];
    }
    if (activeCount !== 1 || activeStrip === null) return "unavailable";
    return cellTabIdsOf(column).readable === true ? "readable" : "foreign";
  }

  /**
   * 区分「两列但第二列内容暂不可读」与「组成明确不再是目标」。
   *
   * 为什么需要它：重启恢复（宿主从持久化布局恢复右栏）时，split 容器往往比列内的 tab 条 /
   * inventory 归属早几帧出现。这段窗口里 splitOwnsExpertPair 会返回 false，但 false 同时
   * 覆盖了两种完全不同的现实：
   * - **暂不可读**（本函数返回 "unavailable"）：结构上仍是两列，列 0 明确是本会话的
   *   Expert Group 页，只有列 1 整列还没有活跃 tab 条（tab 条比 split 容器晚若干帧提交）。
   *   此时组成只是「还没读完」，插件应当保持已写下的配比并短延迟重试，绝不闪回宿主默认值；
   * - **明确非目标 / 单列**（返回 "foreign"）：列数不是精确的 0/1 两列、列 0 不是 Expert Group
   *   页、列 0 的 tab 无法归属、或两列里混进重复/未知归属。这些都没有可证明的 40:60，必须
   *   按原有 fail-closed 语义交还宿主。
   *
   * 归属判定与 splitOwnsExpertPair 完全同源（同一份 tabSets、同一条唯一活跃 strip 读法），
   * 因此这里**不引入任何新的宽松证据**：pending 只在「目标那一侧已经被证明」时才成立，
   * 首次接管（从未写过目标配比）也绝不会因为列 1 读不出来就去猜页面归属。
   */
  function splitPairPendingOf(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return "foreign";
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return "foreign";
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return "foreign";
    // 列 0 必须是可读且明确属于本会话的 Expert Group 页：读不出来就没有「已确认的目标」。
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    if (expertTabs.readable !== true || expertTabs.ids.size === 0) return "foreign";
    for (const tabId of expertTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return "foreign";
      if (tabSets.expert.has(tabId) !== true) return "foreign";
    }
    // 列 1 只有「整列还没有活跃 tab 条」这一种形状算暂不可读；其余（组成读得出来、可见 host
    // 没有 strip、一个逻辑列多个活跃 strip、hidden 不可读等）都是「明确不是目标」，交回严格判定。
    return cellPendingStateOf(byColumn.get("1")) === "unavailable" ? "unavailable" : "foreign";
  }

  /**
   * 在面板里按给定判据挑出**唯一**的分栏容器。
   *
   * 面板内部可能同时存在多个 split（列的内容区里嵌着的另一个 dock 也有自己的 split），因此
   * 判据命中多个时一律视为归属不明确并返回 null（调用方 fail-closed，绝不挑第一个猜测）；
   * 返回数组的形态让调用方可以自行决定「零个 / 一个 / 多个」的处理方式（见下面的两个包装）。
   */
  function uniqueSplitBy(panel, matches) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return [];
    let nodes = null;
    try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_SPLIT_SELECTOR)); } catch { return []; }
    const resolved = [];
    for (const node of nodes) {
      if (matches(node) !== true) continue;
      resolved.push(node);
      if (resolved.length > 1) break;
    }
    return resolved;
  }

  /**
   * 在面板里找出**唯一**可解析的分栏容器。
   *
   * 只有满足 splitOwnsExpertPair 的那一个才是本插件的目标：零个表示还没分栏或形态不认识，
   * 多个表示归属不明确——两种情况都返回 null（调用方 fail-closed）。
   */
  function resolveSplitContainer(panel, tabSets) {
    const resolved = uniqueSplitBy(panel, (node) => splitOwnsExpertPair(node, tabSets) === true);
    return resolved.length === 1 ? resolved[0] : null;
  }

  /**
   * 找出面板里**唯一**的「暂不可读 pending」分栏容器（见 splitPairPendingOf 的说明）。
   *
   * 零个表示这一轮没有任何可保持目标配比的两列结构，多个表示归属不明确——调用方据此走
   * 原有的交还宿主分支，绝不挑第一个猜测。返回数组（而不是元素或 null），因为「零个」与
   * 「多个」在这里都必须与「恰好一个」区分开。
   */
  function splitPairPendingContainers(panel, tabSets) {
    return uniqueSplitBy(panel, (node) => splitPairPendingOf(node, tabSets) === "unavailable");
  }

  /**
   * 解析 grid-template-columns 的三轨形态。
   *
   * 真实右栏是「列 0 | 0px 分隔轨 | 列 1」三条轨道，两端必须是 `minmax(0,<数字>fr)`：只有这种
   * 形态才谈得上 40% / 60%，其余（单轨、repeat()、固定 px、轨道数不符、括号不闭合）一律返回
   * null，调用方绝不写。中间那条轨道原样返回给调用方复用——它是宿主自己的分隔轨，插件不改写。
   */
  function parseSplitTracks(raw) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") return null;
    const tracks = [];
    let depth = 0;
    let current = "";
    for (const character of value) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && /\s/.test(character)) {
        if (current !== "") { tracks.push(current); current = ""; }
        continue;
      }
      current += character;
    }
    if (depth !== 0 || current === "") return null;
    tracks.push(current);
    if (tracks.length !== 3) return null;
    const first = splitEndTrackFr(tracks[0]);
    const last = splitEndTrackFr(tracks[2]);
    if (first === null || last === null) return null;
    return { first, last, middle: tracks[1] };
  }

  /** 端点轨道必须是 `minmax(0,<数字>fr)` 或 CSSOM 规范化后的 `minmax(0px,<数字>fr)`；其余形态一律不认。 */
  function splitEndTrackFr(track) {
    const match = /^minmax\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(track);
    if (match === null) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * 右栏拖拽手柄锁：**只在 Expert Group 页确实是当前活动页时**生效，切换页面或卸载立刻恢复。
   *
   * 需求：Expert Group 页的宽度固定为视口宽度的 20%，用户不能在这一页上把右栏拖成别的宽度；
   * 而其它右侧分页（子代理聊天、文件等）必须继续能正常 resize。因此绝不能全局禁用这个手柄
   * （那是宿主 AppFrame 的公共元素，别的页面、甚至同一会话里的其它 tab 都要用它），只能在
   * 「当前活动 tab 就是 Expert Group」时逐次加锁、离开时逐次解锁。
   *
   * 最小侵入写法：只往这一个元素的内联样式上写两条属性（禁用指针事件 + 复位光标形状），
   * 不注入全局 CSS、不加 class、不改 DOM 结构，也绝不碰宿主的 data-* 属性：
   * - pointer-events: none —— 拖拽入口（pointerdown）根本收不到事件，宽度不可能被拖走；
   * - cursor: default —— 鼠标悬停时不再显示 col-resize 的「可拖拽」暗示。
   * 两条都带 important：宿主自己给手柄写了 hover 态样式，普通内联声明可能被主题的
   * !important 规则盖掉（与过渡抑制同一取舍）。
   *
   * 恢复用「值与优先级都仍等于本次写入才还原」的保守判定：锁存窗口内被宿主/主题/页面脚本
   * 改写过的属性一律保留外部状态，原本没有内联声明就删除，绝不用旧值覆盖新值。
   *
   * 句柄的存活性复用**已有的 tab 观察生命周期**：Expert Group 面板已挂在 body 子树的
   * childList observer + 2.5 秒轮询 + visibilitychange 上（见 syncSidebarTabs），宿主重新挂载
   * 这枚手柄本身就是一次 childList 变化，因此锁会随那条生命周期重新找句柄并补写——插件不为
   * 此再加一个长期 MutationObserver，宿主上的观察器数量与既有行为完全一致。
   *
   * 解锁（切换页面）与 dispose 都必须还原样式：绝不在宿主上留下「永久不可拖拽」的手柄，
   * 也绝不留下任何全局样式或残留属性。
   *
   * 全程 fail-safe：没有 document / 没有 querySelector / 句柄还没挂载 / style 不是可写对象，
   * 都只是「这一次没锁上」，绝不影响页面打开与渲染。
   */
  function createRightbarDragLock() {
    /** 插件写入手柄的两条最小侵入样式（顺序固定：先禁用指针事件，再复位光标）。 */
    const HANDLE_STYLE_WRITES = Object.freeze([
      { name: "pointer-events", value: "none" },
      { name: "cursor", value: "default" },
    ]);
    let locked = false;
    let element = null;
    /** 每条属性写入前的内联值与优先级；解锁时逐条按「未被外部改写」判定后还原。 */
    let previous = null;

    const readHandle = () => {
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        return doc.querySelector(RIGHTBAR_DRAG_HANDLE_SELECTOR) ?? null;
      } catch { return null; }
    };
    const readStyle = (style, name) => {
      try { return typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : ""; } catch { return ""; }
    };
    const readPriority = (style, name) => {
      try { return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(name) : ""; } catch { return ""; }
    };

    /** 还原锁期间写过的内联样式；只回写「当前值与优先级都仍是本次写入」的那些属性。 */
    const restore = () => {
      const target = element;
      const saved = previous;
      element = null;
      previous = null;
      if (target === null || saved === null) return;
      let style = null;
      try { style = target.style || null; } catch { style = null; }
      if (style === null) return;
      for (const entry of saved) {
        try {
          if (readStyle(style, entry.name) !== entry.written) continue;
          if (readPriority(style, entry.name) !== entry.writtenPriority) continue;
          if (entry.value === "" || entry.value === null || entry.value === undefined) style.removeProperty?.(entry.name);
          else style.setProperty(entry.name, entry.value, entry.priority || "");
        } catch { /* 单条属性还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */ }
      }
    };

    /** 查找并锁定手柄；句柄不在 DOM 里时返回 false，由下一次同步（面板的 tab 观察生命周期 / 会话通知）补上。 */
    const apply = () => {
      if (locked !== true) return false;
      const candidate = readHandle();
      if (candidate === null) return false;
      if (candidate !== element) {
        // 宿主换了一枚新手柄（React 重挂载）：旧节点已经不在文档里，直接改记新节点，
        // 不为它保留恢复信息（还原一个已被移除的节点没有任何意义）。
        element = candidate;
        previous = null;
      }
      let style = null;
      try { style = candidate.style || null; } catch { style = null; }
      if (style === null || typeof style.setProperty !== "function") return false;
      if (previous === null) {
        previous = HANDLE_STYLE_WRITES.map(({ name }) => ({
          name,
          value: readStyle(style, name),
          priority: readPriority(style, name),
          written: null,
          writtenPriority: null,
        }));
      }
      HANDLE_STYLE_WRITES.forEach(({ name, value }, index) => {
        // 已经是锁状态就不重复写：既避免无谓的样式写入，也让重复同步保持幂等。
        if (readStyle(style, name) === value) return;
        try {
          style.setProperty(name, value, "important");
          // 写入后回读：宿主可能规范化或忽略 priority，恢复判定必须用「实际写入的状态」。
          previous[index].written = readStyle(style, name);
          previous[index].writtenPriority = readPriority(style, name);
        } catch { /* 写入失败：保留已经写上的那几条，绝不影响页面其它行为。 */ }
      });
      return true;
    };

    return {
      /**
       * 同步锁状态：true 立即锁（已锁时再核对一遍：宿主重建句柄或改写内联样式时按需补写），
       * false 立刻还原样式。返回当前是否处于锁定态，便于调用方与测试断言。
       */
      setLocked(next) {
        const target = next === true;
        if (target === locked) {
          if (target) apply();
          return locked;
        }
        locked = target;
        if (target) apply();
        else restore();
        return locked;
      },
      isLocked: () => locked,
      /** 卸载收尾：还原样式并复位状态，绝不在宿主上留下全局或残留样式。 */
      dispose() {
        locked = false;
        restore();
      },
    };
  }

  /**
   * 分栏列宽的写入器：只往 split 容器的**内联 grid-template-columns** 上写一条三轨值。
   *
   * 需求：用户第一次分栏后右栏总宽度保持视口的 50%，但 Expert Group 页必须回到视口 20%——
   * 也就是右栏内部 40% / 60%，而不是宿主默认的等分（等分时 Expert Group 页只剩视口 25%）。
   * 真实 DockKit 右栏的实际列宽由 split 容器这一条内联 grid-template-columns 决定
   * （`minmax(0,0.5fr) 0px minmax(0,0.5fr)`）：列内的 flex-grow 不参与真实列宽计算，因此这里
   * 只把它改成 `minmax(0,0.4fr) 0px minmax(0,0.6fr)`，中间那条分隔轨原样保留。
   *
   * 触发时机（与手柄锁完全共用同一条生命周期，不新挂任何 observer）：
   * - install 期的 openTargets（sessions / Better 状态通知）；
   * - 面板的 MutationObserver（body 子树 childList）、2.5 秒轮询、visibilitychange；
   * - 分栏事务提交后与关闭点击后的那次同步。
   * 因此宿主把新列渲染出来的那一帧之后配比会被补上，列消失后同一条链路会立刻还原。
   *
   * 写入与恢复规则（保守，绝不覆盖宿主后续写入）：
   * - 首次接管这个容器时保存宿主的原值与优先级（绝不用插件自己的值当原值）；
   * - 组成仍有效时：已经是目标值 → 零写入；仍是插件写下的状态（宿主只规范了文本形式）→ 零写入；
   *   回到宿主自己的默认形态（两端 fr 相等的等分，或捕获到的原值）→ 重新施加目标配比；
   *   其它不等的值视为宿主/用户的刻意改动 → 让位，不写；
   * - 交还（dispose / 单列 / Expert Group 消失 / 三列 / 读面不可用 / session 切换）时，只有
   *   「当前值与优先级都仍然是本次写入」才写回原值，被外部改写过的值一律保留；
   * - dispose 之后任何迟到回调都不再写入（disposed 短路）。
   *
   * 全程 fail-safe：没有 document / 没有容器 / 当前值承载不了三轨形态 / style 不可写，都只是
   * 「这一轮没写」，绝不影响页面打开、分栏事务与手柄锁。
   */
  function createSplitTrackRatio() {
    /** 当前接管中的容器（最多一个）：元素身份 + 本写入器写下的实际状态（含宿主规范化后的文本）。 */
    let applied = null;
    /** 首次接管时的宿主原值与优先级；按容器身份记忆，绝不让插件自己的值被当成原值。 */
    let hostCapture = null;
    /** dispose 之后所有同步（含已经排队的迟到回调）一律短路，绝不再碰宿主样式。 */
    let disposed = false;
    /**
     * 「暂不可读」pending 的记账（**只在已经写进过目标配比之后**才可能成立）。
     *
     * 语义：容器上当前就是插件写下的目标配比，但这一轮读面读不出「列 1 是本会话的另一个已知页」，
     * 也没有任何证据说明组成真的失效了（结构仍是两列、列 0 仍是 Expert Group 页）。
     * 此时用 applyRatio 维持/修复目标配比，并安排一次短延迟重试去重新求值——这正是重启恢复
     * 窗口里避免 target → host default 闪回的机制。
     *
     * attempts 的语义是「**实际执行过的** pending retry timer 轮数」：只有 schedulePendingRetry
     * 的回调真正跑起来才自增，外部同步（sessions 广播 / observer / 轮询）只读取它、绝不修改，
     * 因此同一个 400ms 等待期内的任意多次通知都不会提前耗尽预算。
     */
    let pending = null;
    /** 去重用的待执行重试定时器句柄：同一时刻最多一个，重复同步绝不堆积。 */
    let pendingRetryTimer = null;
    /**
     * 最近一次同步传入的**真实读面函数**（install 收尾接线的 splitTrackReader.readTarget）。
     *
     * 重试 timer 必须用它重新读一遍当前 document / session / panel / split / inventory 状态，
     * 绝不能把上一轮那个 "pending" 结论原样回放：回放的话 timer 自己永远看不到「读面已经恢复」，
     * 收敛就只能依赖外部的 sessions / observer 通知，而重启恢复窗口里恰恰没有这些通知——
     * 结果是重试预算被白白烧完，配比反而被交还给宿主默认值（闪回）。
     *
     * 读面本身是纯函数式的现读（不依赖 this，也不缓存 DOM），因此这里只保存函数引用即可，
     * 每次调用都会重新求值。读面为 null（install 收尾前）时 pending 不可能被建立。
     */
    let lastReader = null;

    /** 读一条内联值与优先级；任何能力缺失/抛错都返回 null，由调用方按「读不到」处理。 */
    const readInline = (style, name, readerName) => {
      try {
        if (style === null || style === undefined) return null;
        const reader = style[readerName];
        if (typeof reader !== "function") return null;
        const value = reader.call(style, name);
        return value === null || value === undefined ? "" : String(value);
      } catch { return null; }
    };
    const readValue = (style, name) => readInline(style, name, "getPropertyValue");
    const readPriority = (style, name) => readInline(style, name, "getPropertyPriority");

    /** split 容器的内联样式对象；读不到（没有 style / 替身缺 API）时返回 null。 */
    const styleOf = (container) => {
      try {
        const style = container?.style ?? null;
        if (style === null || typeof style.setProperty !== "function") return null;
        return style;
      } catch { return null; }
    };

    /**
     * 目标值：沿用宿主当前那条分隔轨，只把两端换成 0.4 / 0.6。
     *
     * parsed 为 null 表示宿主当前没有内联声明（没有可沿用的分隔轨）：这时用规范分隔轨，
     * 写成与真实右栏一致的三轨形态。
     */
    const composeDesired = (parsed) =>
      "minmax(0," + SIDEBAR_SPLIT_EXPERT_TRACK + "fr) "
      + (parsed === null ? SIDEBAR_SPLIT_GAP_TRACK : parsed.middle)
      + " minmax(0," + SIDEBAR_SPLIT_OTHER_TRACK + "fr)";

    /** 记录宿主原本的内联值与优先级（同一个容器只记一次，宿主重渲染不会让插件值变成新基线）。 */
    const captureHostStyle = (container) => {
      if (hostCapture !== null && hostCapture.container === container) return true;
      const style = styleOf(container);
      if (style === null) return false;
      const value = readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      const priority = readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      if (value === null || priority === null) return false;
      hostCapture = { container, value, priority };
      return true;
    };

    /**
     * 当前值是否值得让插件重新施加目标配比。
     *
     * - 还没捕获过这个容器的宿主原值 → true（首次接管，按插件契约施加）；
     * - 值与捕获到的宿主原值一致 → true（宿主重渲染回自己的默认值）；
     * - 宿主当前没有内联声明 → true（宿主没有自己的意见，写它不会覆盖宿主写下的值）；
     * - 三轨形态两端 fr 相等 → true（宿主默认的等分，文本形式可能与捕获值不同）；
     * - 其余（不等的第三值，例如用户/别的插件拖过分隔条）→ false：插件让位并保留外部状态。
     */
    const shouldApply = (container, parsed, current) => {
      if (hostCapture === null || hostCapture.container !== container) return true;
      if (current === "") return true;
      if (hostCapture.value === current) return true;
      return parsed !== null && parsed.first === parsed.last;
    };

    /**
     * 按容器当前值决定这一轮要不要写。
     *
     * 返回值只表示「这一轮之后容器上的配比是不是目标状态」：让位（保留外部值）时返回 false，
     * 但绝不因此去改写宿主样式。
     */
    const applyRatio = (container) => {
      const style = styleOf(container);
      if (style === null) return false;
      const current = readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      const currentPriority = readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      if (current === null || currentPriority === null) return false;
      const parsed = parseSplitTracks(current);
      // 宿主换成了别的非三轨写法（固定 px、repeat() 等）：插件不猜结构，直接让位。
      // 只有「宿主没有内联声明」（空值）才用规范分隔轨补一条三轨值。
      if (current !== "" && parsed === null) return false;
      const desired = composeDesired(parsed);
      // 1) 已经是目标值：零写入（重复同步、面板重挂载都走这条路径）。
      if (current === desired) return true;
      // 2) 仍是插件自己写下的状态（宿主可能只规范了文本形式）：零写入，避免写入回环。
      if (applied !== null && applied.container === container
        && current === applied.written && currentPriority === applied.writtenPriority) return true;
      // 3) 外部刻意改过的非等分值：让位，保留外部值，绝不盖回目标配比。
      if (shouldApply(container, parsed, current) !== true) return false;
      // 4) 首次接管先记住宿主原值；记不下来就不写（绝不让插件自己的值成为恢复基线）。
      if (captureHostStyle(container) !== true) return false;
      // 沿用宿主原本的优先级：插件只改「谁长多少」，绝不顺手改级联强度，也不用 !important 压主题。
      try { style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY, desired, currentPriority); } catch { return false; }
      // 回读：宿主可能规范化文本形式（例如补空格），恢复判定必须用实际写入的状态。
      applied = {
        container,
        written: readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY),
        writtenPriority: readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY),
      };
      return true;
    };

    /** 交还控制权：只有当前值与优先级都仍是本次写入，才写回宿主原值（否则保留外部状态）。 */
    const restore = () => {
      const entry = applied;
      applied = null;
      if (entry === null) return;
      const style = styleOf(entry.container);
      if (style === null) return;
      if (readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY) !== entry.written) return;
      if (readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY) !== entry.writtenPriority) return;
      if (hostCapture === null || hostCapture.container !== entry.container) return;
      try {
        if (hostCapture.value === "") style.removeProperty(SIDEBAR_SPLIT_TRACK_PROPERTY);
        else style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY, hostCapture.value, hostCapture.priority);
      } catch { /* 还原失败只影响外观，后续同步仍按同一规则重试。 */ }
    };

    /** 取消待执行的重试（去重的唯一出口）：dispose、容器更换、状态离开 pending 时都必须调用。 */
    const cancelPendingRetry = () => {
      if (pendingRetryTimer === null) return;
      const timer = pendingRetryTimer;
      pendingRetryTimer = null;
      try {
        // 句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };

    /** 结束 pending：清掉容器身份、重试预算与待执行定时器（三个字段必须一起复位，绝不留半状态）。 */
    const clearPending = () => {
      pending = null;
      cancelPendingRetry();
    };

    /**
     * 为「暂不可读」安排一次短延迟重试。
     *
     * 三条硬约束（对应契约里的「有界、去重、可取消」）：
     * - 去重：pendingRetryTimer 非空就直接返回，重复同步（面板 observer / 2.5 秒轮询 / 宿主广播）
     *   绝不堆积定时器；
     * - 有界：**实际执行过的 timer 轮数**达到上限后不再重排，按「组成确实失效」交还宿主样式；
     * - 可取消：dispose、容器更换、状态离开 pending 时都会 cancelPendingRetry。
     *
     * 预算的记账点只有一个：**这个回调真正开始执行的那一刻**。外部同步（sessions 广播 /
     * observer / 轮询）无论触发多少次都不消耗预算——它们只是在同一个 400ms 等待期内重复求值，
     * 若也去自增 attempts，真实 timer 一轮都没跑预算就被烧完，重启恢复窗口会提前闪回宿主比例。
     *
     * 回调里先出队，把这一轮计入预算，再用**真实读面**重新求值一次（sync(lastReader)）：
     * 若读面已经恢复，sync 会走正常路径重新落到目标配比并立即清空 pending；若仍是 pending，
     * sync 会在预算内重排下一个 timer，预算耗尽时则 clearPending + restore（有界收敛）。
     * 没有可用调度器时只是「这一轮不重试」，任何一次既有同步仍会重新求值，绝不影响页面其它行为。
     */
    const schedulePendingRetry = (container) => {
      if (disposed || pendingRetryTimer !== null) return;
      try {
        pendingRetryTimer = globalThis.setTimeout(() => {
          pendingRetryTimer = null;
          if (disposed) return;
          // 迟到 timer：容器/状态已经变过（session 切换、容器重挂载、已收敛），一律不再动作。
          if (pending === null || pending.container !== container) return;
          const entry = pending;
          // 读面函数缺失时不做任何猜测性写入：这一轮什么都不做，等下一次真实同步。
          if (typeof lastReader !== "function") return;
          // 这一轮 timer 确实执行了 → 只有这里消耗一轮预算（外部同步绝不走这条路径）。
          pending = { container, attempts: entry.attempts + 1 };
          sync(lastReader);
          // sync 自己会在「仍是 pending 且预算未耗尽」时重排。这里只兜底它提前返回的情况
          // （例如 document 读面不可用）：pending 还在、预算还有、却没有 timer，必须补一个，
          // 否则有界重试会静默中断；attempts 已经自增，因此补排也必然有界。
          if (pending !== null && pending.container === container
            && pendingRetryTimer === null
            && pending.attempts < SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS) {
            schedulePendingRetry(container);
          }
        }, SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS);
      } catch {
        // 没有可用调度器：放弃这一轮重试（pending 保留，下一次同步会重新求值）。
        pendingRetryTimer = null;
      }
    };

    /**
     * 按当前右栏 DOM 组成重估一次列宽配比。
     *
     * 读面全部由调用方以参数交进来（readTarget 每次现读 session / panel / split 容器）：
     * 这里**不引用** install 体内的任何后置 const（那是 TDZ 陷阱的来源），所有输入都是显式依赖，
     * 调用点必须自己保证它们就绪。
     *
     * readTarget 返回 { status, container }：
     * - status 缺省 / "target"：组成可证明，按 applyRatio 施加目标配比；
     * - status "pending"：**已经写过目标配比**、但这一轮读不出列 1 的组成（重启恢复窗口）——
     *   继续用 applyRatio 维持/修复目标配比并短延迟重试，绝不闪回宿主默认值，也绝不覆盖外部值；
     * - 其余（null、单列、明确非目标）：交还宿主样式。
     *
     * 返回 true 表示这一轮之后插件仍持有 pending 或配比确实落在容器上（含幂等命中），
     * false 表示已还原 / 让位 / 未写入。调用方（requestSplitTrackSync 的各入口）不使用这个布尔值，
     * 它只服务于重试回调的兜底重排。
     */
    const sync = (readTarget) => {
      if (disposed) return false;
      // 记住本次的真实读面：pending 重试 timer 必须用它重新现读状态，而不是回放上一轮结论。
      if (typeof readTarget === "function") lastReader = readTarget;
      // document 读面不可用：连「有没有分栏容器」都无法证明，保持现状（绝不猜测性还原）。
      let doc = null;
      try { doc = globalThis.document ?? null; } catch { doc = null; }
      if (doc === null || typeof doc.querySelector !== "function") return applied !== null;
      // readTarget 自己负责「面板属于哪个 session」与「两列分不分得清」；拿不到可证明的组成
      // （面板没挂载 / 单列 / 三列 / Expert Group 页消失 / session 切换 / 读面抛错）时交还宿主。
      let target = null;
      // 读面抛错等价于「组成读不出来」：交还宿主，绝不让异常外溢到同步调用点
      // （那些调用点只包了「失败不影响宿主」的兜底，异常外溢会让后面的宽度/手柄逻辑一起被跳过）。
      try { target = typeof readTarget === "function" ? readTarget(doc) : null; } catch { target = null; }
      if (target === null || target.container === null || target.container === undefined) {
        clearPending();
        restore();
        return false;
      }
      // 容器换了（宿主重挂载 / 切到另一条 surface）：先作废上一轮的 pending 记账，再交还旧容器。
      if (pending !== null && pending.container !== target.container) clearPending();
      if (applied !== null && applied.container !== target.container) restore();
      // 「暂不可读」只在**已经写过目标配比**之后才成立：没有 applied 就没有需要保持的样式，
      // 首次接管必须继续走原有 fail-closed 语义——绝不因为列 1 读不出来就去猜页面归属，
      // 也绝不凭空列或缺失 inventory 把未知页面当成目标（这条边界不能放松）。
      if (target.status === "pending" && applied !== null && applied.container === target.container) {
        // attempts 只统计**实际执行过的 pending retry timer 轮数**（由 schedulePendingRetry 的
        // 回调自增）。外部同步——sessions 广播、面板 observer、2.5 秒轮询——无论在同一等待期内
        // 触发多少次，都既不消耗预算也不重置预算，只维持 pending 并保证最多一个 timer。
        const attempts = pending !== null && pending.container === target.container ? pending.attempts : 0;
        if (attempts < SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS) {
          // 暂不可读期间同样要维持配比，不能只「保持当前样式」：宿主可能在这段窗口里重渲染回
          // 它自己的等分形态（甚至清掉内联声明），那样错误比例会一直留在屏幕上，直到预算耗尽
          // 也回不到 40/60。这里复用与「组成可证明」时**完全相同**的 applyRatio：
          // - 目标值 / 宿主自己的等分 / 宿主清空内联声明 → 保持或修复回目标配比；
          // - 外部刻意写下的非等分值 → 由 shouldApply 让位，绝不覆盖（不引入第二套写入规则）。
          applyRatio(target.container);
          // 首次进入 pending 才建立记账（attempts 从 0 起）；已存在时原样保留已消耗的预算，
          // 绝不因外部同步累加（那会让预算在 timer 一轮都没跑时就被烧完）或重置。
          if (pending === null) pending = { container: target.container, attempts: 0 };
          schedulePendingRetry(target.container);
          // 保持 pending：组成还没恢复，继续有界重试（applyRatio 让位时也不改写外部值）。
          return true;
        }
        // 预算已经被**实际 timer 轮次**耗尽仍读不出来：按「组成确实失效」交还宿主样式并停止重排。
        clearPending();
        restore();
        return false;
      }
      // 组成可证明：清空 pending 记账后按目标配比重新求值（读面恢复时这一步会清掉重试预算）。
      clearPending();
      // 「暂不可读」但还没有可保持的样式：这一轮什么都不写（不是目标，也不猜测），
      // 由后续同步在组成可证明时再施加。
      if (target.status === "pending") return false;
      return applyRatio(target.container);
    };

    return {
      sync,
      /**
       * 卸载收尾：取消待执行的重试、还原内联声明并置位 disposed，之后任何迟到同步都不再写入。
       * 定时器必须在这里释放——卸载后插件不得再碰宿主样式，也不留下泄漏的 timer。
       */
      dispose() {
        disposed = true;
        clearPending();
        restore();
      },
    };
  }

  function createExpertGroupPanel(deps) {
    const config = object(deps);
    const react = config.react;
    const primitives = config.primitives || {};
    if (!react || typeof react.createElement !== "function") {
      return function MissingReactPanel() { return null; };
    }
    styleTag();

    /**
     * 最近一次成功的 normalized 快照缓存（挂在 createExpertGroupPanel 闭包上，跨 Panel 实例共享，
     * 按 rootSessionId 隔离）。
     *
     * 症状与根因：真实 DSH 的 keyed session surface 在切换会话时可能卸载旧 Panel 实例、再用同一个
     * Panel 函数挂载新实例。旧实例卸载后，新实例的 useState 从「snapshot=null + loading=true」重新
     * 开始，于是同一个 root 的任务树会先渲染两条 .deg_expert_group_skeleton，等 RPC 回来才恢复——
     * 用户在切换子代理时看到的就是这两块灰色占位闪烁。
     *
     * 缓存只解决内容首屏：命中时让新实例的初始 state 直接就是「已加载」的快照（loading=false），
     * 首帧即渲染任务树；没有缓存的真正首次访问仍按原语义显示 skeleton。后台刷新（RPC、通知、轮询、
     * 尾随刷新、展开状态）一律照旧发起，因此缓存不延迟数据更新，也不改变任何错误语义。
     *
     * 只缓存 normalized 成功快照（safeNormalize 通过且真正上屏的那一份）：失败、被取消或过期 root
     * 的响应都不进缓存，所以「旧会话内容不得显示到新会话」的边界不受影响。
     *
     * 渲染纯性：缓存的「命中即重排 LRU」副作用绝不能出现在渲染路径上。渲染期的访问被压缩到
     * 两处且都只允许纯读 peek：新实例挂载那一帧（懒初始化）与同一实例切换 root 的视图回退分支；
     * 同一 root 的普通重渲染（通知、轮询、展开状态变化）完全不触碰缓存。LRU 重排与写入一律
     * 收敛到事件路径，详见下方 peekCachedSnapshot / writeCachedSnapshot 的说明。
     */
    /**
     * 缓存的两条访问通道（渲染纯性的边界）：
     *
     * - peekCachedSnapshot：**纯读**，命中返回快照、未命中返回 null，绝不改动 Map 的迭代顺序。
     *   计算首屏状态必须发生在渲染期（React 的任何取值入口都在渲染阶段，要让首帧直接显示缓存
     *   的任务树，就不可能把这一次读取推迟到 effect），因此渲染路径只允许走这条纯读通道；
     *   纯读是「同样缓存内容 ⇒ 同样结果」的引用透明读取，不会给渲染引入可观察副作用。
     * - writeCachedSnapshot：唯一会**改动**缓存的入口（delete+set 重排 LRU、超限淘汰、写入新值），
     *   只允许在事件路径（RPC 成功回调）调用。旧实现在每次渲染里用「命中即重排」的读函数
     *   （readCachedSnapshot），StrictMode 的双渲染会把每次渲染额外变成两次 LRU 重排，
     *   视图回退分支更是每帧空转重排——那些重排全部从这里删除。
     *
     * 提权（LRU 新鲜度）语义因此收敛为「最近成功拉取过的 root 最新」：正在被观察的 root 由它自己的
     * 成功刷新（含内容不变的轮询响应）保持新鲜，只被渲染过却始终没拉取成功的 root 不会顶掉别人。
     */
    const SNAPSHOT_CACHE_LIMIT = 32;
    /** rootSessionId → 最近成功的 normalized 快照；Map 的迭代顺序即 LRU 顺序（末尾最新）。 */
    const snapshotCache = new Map();
    /**
     * 日常打开/关闭子代理 tab 不改写右栏宽度；只有首次从 Expert Group-only 单 pane 创建
     * 子代理 pane 时，install 侧事务会在 split() 前临时从 20% 扩到 50%。目标资源在返回 pane
     * 的 openTabs + DOM 证据都落地后才提交 other 模式，失败则恢复 Expert Group 的 20% 锁定。
     *
     * 这样移除了旧实现的 expandedSubagentTabs / pendingSubagentWidthTabs 与两档 25%↔50%
     * 换算，同时保留 tab 的开/关与外部关闭同步语义：它们只维护 sidebarTabRecordsRef 中的
     * 精确 tabId 记录。
     */
    /** 纯读缓存：命中返回快照，未命中返回 null；绝不重排 LRU、绝不写入（渲染路径只允许用它）。 */
    const peekCachedSnapshot = (rootSessionId) => {
      if (rootSessionId === "" || snapshotCache.has(rootSessionId) !== true) return null;
      return snapshotCache.get(rootSessionId) ?? null;
    };
    /**
     * 写缓存并做有限 LRU 淘汰：同一 root 覆盖旧值并移到最新；超过上限时从最久未使用的 root 开始
     * 删除，保证长时间反复切换会话也不会无界增长（上限内每个 root 至多一份快照）。
     */
    const writeCachedSnapshot = (rootSessionId, next) => {
      if (rootSessionId === "" || next === null || next === undefined) return;
      snapshotCache.delete(rootSessionId);
      snapshotCache.set(rootSessionId, next);
      while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
        const oldest = snapshotCache.keys().next();
        if (oldest.done === true) break;
        snapshotCache.delete(oldest.value);
      }
    };
    /**
     * 某个 root 的初始展示状态：命中缓存就是「已有快照、已加载」，未命中仍是 skeleton 语义。
     * 错误信息不缓存——上一次失败不该污染新实例的首屏（真正的失败会在本次刷新里重新得到）。
     * 只做纯读 peek：命中不改变 LRU 顺序，因此调用它（挂载帧 / 视图回退分支，含 StrictMode
     * 双渲染）不会产生任何缓存副作用。
     */
    const initialStateFor = (rootSessionId) => {
      const cached = peekCachedSnapshot(rootSessionId);
      return { rootSessionId, snapshot: cached, loading: cached === null, error: null };
    };

    function Panel(props) {
      const ctx = props?.ctx || config.ctx;
      let tabInfo = null;
      if (typeof props?.useTabInfo === "function") {
        try { tabInfo = props.useTabInfo(); } catch { tabInfo = null; }
      }
      const tabParams = object(tabInfo?.tab?.navigation?.params);
      // 每次渲染只读一次 sessions 快照：官方目录项（mode/activity）与权威 title 都来自它，
      // 会话订阅触发的重渲染因此能刷新第三行。0.1.7-alpha.2 的目录改为按会话 id 索引的
      // 会话投影（projectionsBySession[sessionId].values.subagentCatalog）。
      const sessionsSnapshot = listSnapshot(config, ctx);
      // 目录查找表与快照同一帧只建一次：每行渲染都用它取官方目录项（mode/activity），
      // 旧实现每行都要线性扫描一次 entries，行数一多就成了主要渲染成本。
      const catalogEntryOf = createCatalogLookup(sessionsSnapshot);
      const fallbackCurrent = currentSessionIdOf(sessionsSnapshot);
      const scopedId = typeof config.sessions?.scopeOf === "function" ? config.sessions.scopeOf(ctx) : undefined;
      const scope = props?.scope || props?.tab?.scope || tabInfo?.scope || {};
      const sessionId = text(scope.sessionId, text(props?.sessionId, text(props?.rootSessionId, text(tabParams.rootSessionId, text(scopedId, fallbackCurrent)))));
      let resolvedRoot = sessionId;
      if (typeof config.resolveRootSessionId === "function" && sessionId !== null) {
        try { resolvedRoot = text(config.resolveRootSessionId(sessionId, undefined, listSnapshot(config, ctx)), sessionId); } catch { resolvedRoot = sessionId; }
      }
      const rootSessionId = resolvedRoot || "";
      // 右栏 tab 域按当前 Session 隔离；缺失时回退 root，保持旧宿主的确定性作用域。
      const sidebarSessionId = sessionId || rootSessionId;
      // 同一个 root 的最近成功快照由闭包缓存提供：重新挂载（新 Panel 实例）时首帧直接渲染任务树，
      // 不再先闪两条 skeleton；没有缓存的真正首次访问仍然是 snapshot=null + loading=true。
      // 这里用懒初始化：只有挂载那一帧才读一次缓存（StrictMode 会重复调用初始化函数，但缓存读
      // 是纯读、不重排 LRU，因此双调用没有任何可见副作用）。
      const statePair = typeof react.useState === "function"
        ? react.useState(() => initialStateFor(rootSessionId))
        : [initialStateFor(rootSessionId), () => {}];
      const state = statePair[0];
      const setState = statePair[1];
      // rootSessionId 属于请求边界：切换 surface 时先在渲染层隐藏旧树，避免旧会话内容
      // 在新会话首屏等待期间继续占据右栏。真实响应提交时也会再次校验该边界。
      // 切到另一个 root 时用的初始状态是**目标 root** 的状态（有缓存即直接显示它的树）：
      // 缓存按 root 隔离，因此绝不会把旧 root 的内容显示到新 root 上。
      // 只有这条回退分支需要再读一次缓存，且同样走纯读通道；同一 root 的普通重渲染
      // （通知、轮询、展开状态变化）完全不触碰缓存。
      const viewState = state.rootSessionId === rootSessionId ? state : initialStateFor(rootSessionId);
      const versionPair = typeof react.useState === "function" ? react.useState(0) : [0, () => {}];
      const version = versionPair[0];
      const bump = versionPair[1];
      /**
       * 面板标题栏 Auto 开关的本地乐观值（null = 跟随权威读面）。
       *
       * 开关的持久化要走一次 settings-commit 往返；没有本地覆盖时，用户点击后要等下一次
       * 轮询（最长 2.5 秒）才会看到勾选状态变化。这里先乐观翻转，写失败或权威值变化时
       * 立刻回退到读面值（绝不让开关停在错误状态）。
       */
      const autoOpenDraftPair = typeof react.useState === "function" ? react.useState(null) : [null, () => {}];
      const autoOpenDraft = autoOpenDraftPair[0];
      const setAutoOpenDraft = autoOpenDraftPair[1];
      const model = modelApi();
      // 展开状态只依赖 storage 与 root；缓存 store 可避免每次 RPC/通知重渲染都重复读取
      // sessionStorage 和解析同一份展开键。
      const createStore = () => typeof model.createExpansionStore === "function"
        ? model.createExpansionStore({ storage: config.storage, rootSessionId })
        : null;
      const store = typeof react.useMemo === "function"
        ? react.useMemo(createStore, [config.storage, rootSessionId])
        : createStore();
      const mountedRef = typeof react.useRef === "function" ? react.useRef(true) : { current: true };
      const requestSequenceRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
      const contextRef = typeof react.useRef === "function" ? react.useRef(ctx) : { current: ctx };
      contextRef.current = ctx;
      /**
       * 最近一次渲染算出的根会话 id（每次渲染同步写入，与 contextRef 同一模式）。
       *
       * 管理动作（取消/重试）在确认弹窗的 await 之后才发请求，而确认弹窗是宿主级模态：
       * 用户完全可能在它打开期间切换会话。那时 runAction 闭包里捕获的 rootSessionId 已经过期，
       * 用它发请求会把动作打到用户已经切走的旧会话上。这里保存当前选中值，确认完成后重读，
       * 保证动作始终绑定「请求发出这一刻」面板正在展示的根会话。
       */
      const currentRootRef = typeof react.useRef === "function" ? react.useRef(rootSessionId) : { current: rootSessionId };
      currentRootRef.current = rootSessionId;
      const currentSidebarSessionRef = typeof react.useRef === "function" ? react.useRef(sidebarSessionId) : { current: sidebarSessionId };
      currentSidebarSessionRef.current = sidebarSessionId;
      const refreshStateRef = typeof react.useRef === "function"
        ? react.useRef({ rootSessionId: null, inFlight: null, pending: false })
        : { current: { rootSessionId: null, inFlight: null, pending: false } };
      const refresh = () => {
        const refreshState = refreshStateRef.current;
        // 同一组件实例切换 root 时，立即放弃旧请求；旧 Promise 的 finally 通过对象身份检查，
        // 不会清理或触发新 root 的请求。
        if (refreshState.rootSessionId !== rootSessionId) {
          refreshState.inFlight?.controller?.abort?.();
          refreshState.inFlight = null;
          refreshState.pending = false;
          refreshState.rootSessionId = rootSessionId;
        }
        if (refreshState.inFlight !== null) {
          // 通知、轮询和手工重试在同一请求期间只合并成一次尾随刷新。
          refreshState.pending = true;
          return refreshState.inFlight.promise;
        }
        const requestSequence = ++requestSequenceRef.current;
        if (rootSessionId === "") {
          setState({ rootSessionId, snapshot: null, loading: false, error: null });
          return Promise.resolve();
        }
        const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
        const request = { rootSessionId, requestSequence, controller, promise: null };
        refreshState.inFlight = request;
        // 切换 root 时目标 root 的缓存快照必须在**事件路径**里预先读好（纯读，不重排 LRU）：
        // setState 的 updater 可能被 React 在渲染期调用、也可能在 StrictMode 下被调用两次，
        // updater 里读缓存（旧实现）就等于把缓存访投放回渲染阶段。
        const cachedBaseline = peekCachedSnapshot(rootSessionId);
        setState((previous) => {
          if (previous.rootSessionId === rootSessionId) {
            // 同一 root：保留当前快照（尾随刷新绝不清屏）。状态本身没有变化（没有待展示的错误、
            // loading 语义与当前快照一致）时返回原对象 —— React 直接 bail out，2.5s 轮询与
            // 会话通知的空转不再产生任何重渲染。
            const nextLoading = previous.snapshot === null;
            if (previous.error === null && previous.loading === nextLoading) return previous;
            return { rootSessionId, snapshot: previous.snapshot, loading: nextLoading, error: null };
          }
          // 切换 root：用目标 root 的缓存快照顶首屏，缓存未命中仍然是「snapshot=null + loading」
          // 的 skeleton 语义。缓存按 root 隔离，因此这里绝不会把旧 root 的内容显示到新 root 上。
          return { rootSessionId, snapshot: cachedBaseline, loading: cachedBaseline === null, error: null };
        });
        const promise = (async () => {
          try {
            const raw = await callRpc(
              config,
              contextRef.current,
              { action: "expert-group-snapshot", sessionId: rootSessionId },
              controller === null ? {} : { signal: controller.signal },
            );
            const next = safeNormalize(raw);
            if (next === null) throw new Error("快照格式无效");
            // 只有当前请求、当前 root 且页面仍挂载时才允许提交，防止旧 surface 的慢响应
            // 覆盖新会话，同时保证一次尾随刷新不会被旧请求的收尾逻辑吞掉。
            if (mountedRef.current === true
              && refreshState.inFlight === request
              && requestSequence === requestSequenceRef.current
              && rootSessionId === request.rootSessionId) {
              // 只有真正上屏的这份成功快照进缓存：被取消、过期或失败的响应都不写。
              // 写入同时完成 LRU 提权：正在被观察的 root 由它自己的成功拉取保持新鲜
              // （渲染期不再有任何重排，因此提权只能发生在这里）。
              writeCachedSnapshot(rootSessionId, next);
              setState((previous) => {
                // 内容级比较：Host 每次响应都是全新对象（generatedAt 还是新的 Date.now()），
                // 引用不同但上屏内容深度相等时不产生新状态 —— React 直接 bail out，
                // 大任务树空闲时每 2.5s 的全树重渲染就此消失。真实变化一定更新，绝不吞掉。
                if (previous.rootSessionId === rootSessionId
                  && previous.loading === false
                  && previous.error === null
                  && samePanelSnapshot(previous.snapshot, next)) return previous;
                return { rootSessionId, snapshot: next, loading: false, error: null };
              });
            }
          } catch (error) {
            const aborted = controller?.signal?.aborted === true || error?.name === "AbortError";
            if (!aborted
              && mountedRef.current === true
              && refreshState.inFlight === request
              && requestSequence === requestSequenceRef.current
              && rootSessionId === request.rootSessionId) {
              setState((previous) => {
                // 失败时保留当前 root 的最后有效快照（同实例的当前态，或该 root 的缓存快照），
                // 只在标题栏给出错误提示与重试入口；缓存未命中时仍是原来的空态语义。
                // 缓存读取同样在事件路径预先完成（cachedBaseline），updater 保持纯函数。
                const baseline = previous.rootSessionId === rootSessionId
                  ? previous.snapshot
                  : cachedBaseline;
                const message = error instanceof Error ? error.message : String(error);
                // 同一条错误、同一份快照的重复失败同样不产生新状态：失败横幅已经在上屏，
                // 每 2.5s 重排一次标题栏没有意义（错误文案变化时才更新）。
                if (previous.rootSessionId === rootSessionId
                  && previous.error === message
                  && previous.loading === false
                  && previous.snapshot === baseline) return previous;
                return { rootSessionId, snapshot: baseline, loading: false, error: message };
              });
            }
          }
          if (refreshState.inFlight !== request) return;
          refreshState.inFlight = null;
          if (refreshState.pending && mountedRef.current === true && refreshState.rootSessionId === rootSessionId) {
            refreshState.pending = false;
            void refresh();
          } else {
            refreshState.pending = false;
          }
        })();
        request.promise = promise;
        return promise;
      };
      /**
       * 最近一次渲染的 refresh（每次渲染同步写入）。
       *
       * refresh 是闭包：它只认自己那一轮渲染的 rootSessionId，并往对应 root 的状态边界写入。
       * runAction 的 await 可能跨越一次 root 切换，此时旧闭包的 refresh 会为**旧 root** 再发一次
       * 快照请求、并把旧 root 的状态写回新 surface。动作完成后的尾随刷新统一走这个引用，
       * 与当前渲染（也就是当前选中 root）保持一致。
       */
      const refreshRef = typeof react.useRef === "function" ? react.useRef(refresh) : { current: refresh };
      refreshRef.current = refresh;
      /**
       * 子代理侧栏打开状态：复合键（sessionId + rootSessionId + 资源地址）→
       * { sessionId, rootSessionId, tabId, title, misses, origin }。
       *
       * 用 ref 而不是 state 的理由与 pendingSet 相同：一次渲染里可能同时存在多个已打开的子代理
       * （每个 root、每个资源地址各一条记录），状态必须按「哪个 root 的哪个地址」隔离，绝不使用
       * 单一全局 boolean——那会让两个子代理互相顶掉，也无法区分不同会话。重渲染统一走 bump。
       * misses 是该 tab 连续被观测到缺失的次数（见 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS）。
       * origin 是该 tab 的来源（auto | manual，见 SIDEBAR_TAB_ORIGIN_*）：只有 auto 来源才允许
       * 被自动同步关闭，manual 来源（用户手动打开、外部已存在的 tab）一律不碰。
       */
      const sidebarTabRecordsRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
       /**
        * 已发起但尚未从 active() 得到落地证据的打开动作：
        * key → { sessionId, rootSessionId, resourceAddress, expiresAt, origin }。
        *
        * DSH 的 openResource 可能先提交导航意图，下一次渲染才出现 active tab；这段窗口不能让第二次
        * 点击再次 openResource，也不能提前伪造 <<。observer/轮询读到匹配 active() 后才转成正式记录。
        */
       const sidebarTabOpeningRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * Auto（自动打开运行中的子代理侧栏）的来源与抑制账本，键与打开记录完全同构
       * （sidebar session + rootSessionId + 资源地址），因此不同会话/root 的状态互不影响。
       *
       * - 来源：Auto 本次运行亲手发出过打开动作的资源。它同时是「不要重复打开」的记账：
       *   命中即跳过（哪怕这次打开始终没有落地证据，也绝不再发第二次 openResource）；
       *   只有这个集合里的 key 才允许被自动关闭。
       * - 抑制：用户手动关闭过的资源。Auto 不得立刻重开它；用户手动重新打开同一资源时清除
       *   （手动意图始终优先）。
       * 两个集合都按当前快照与上限清理（见 syncAutoSidebarTabs 的清理阶段）。
       */
      const sidebarAutoOriginRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      const sidebarAutoSuppressedRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /** 自动关闭的重试记账：key → 已尝试次数（成功或资源重新变成运行中时清空）。 */
      const sidebarAutoCloseAttemptsRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * 自动打开的**预留**（reservation）：key → { sessionId, rootSessionId, address, epoch }。
       *
       * 与来源标记严格分离：预留只在候选选择的那一刻写入，用来挡住同一资源的重复动作；只有
       * openResource 真的成功发出、且宿主有可追踪能力时才升级成「Auto 亲手打开」的来源。
       * split busy、准备失败、layout 失效、open 抛错、root/sidebar session 变化等失败路径一律
       * 撤销预留（见 handleSidebarAction 的 finally）：否则一次失败会被永久记成「已经开过」，
       * 该资源在本次运行里再也打不开。
       */
      const sidebarAutoReservationRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * 自动动作的级联标记与失败屏障。
       *
       * 撤销预留之后，「下一次同步」会立刻重新选中同一个资源，而自动动作收尾时又会立刻跑一次
       * 尾随同步。若宿主的失败是**持续**的（本会话的 split 事务仍在途 ⇒ busy；宿主持续拒绝分栏；
       * openResource 持续抛错），「失败 → 撤销预留 → 立刻重选」这条链路会在微任务里自转：它永远
       * 不让出宏任务，宿主的提交证据也就永远不会被观察到，页面与预算一起被拖住。
       *
       * 因此：同一次级联（自动动作收尾引发的那条同步链）里失败过的 key 不再入选；失败仍然可重试，
       * 但下一次尝试一定发生在**外部同步轮**（2.5 秒轮询 / observer / 可见性变化 / 会话通知）里，
       * 那里才能观察到形成失败条件的宿主状态是否已经改变。
       */
      const sidebarAutoCascadeRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
      const sidebarAutoFailedKeysRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * Auto 动作代次：Auto 开关的权威值每次变化（含关闭）时递增。
       *
       * 在途自动动作在自己那一轮渲染的闭包里捕获取代次，并在每个 await 之后、真正调用宿主
       * openResource()/close() 之前复核：代次不符说明用户已经关掉（或重新打开）Auto，那次自动
       * 动作一律放弃——绝不把「已经关掉的 Auto」变成一次迟到的用户可见打开。
       */
      const sidebarAutoEpochRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
      /**
       * 用户手动意图记录：key → { sessionId, rootSessionId, address, intent }。
       *
       * 唯一目的：Auto 的动作正在同一个 key 上等待（split/layout/open）时，手动点击不能被 pending
       * 锁直接丢弃。意图只记录「用户要打开还是关闭」，由在途动作在副作用之前让位，或由同一条同步
       * 链路在它收尾后结算（见 applyPendingManualIntent）：手动关闭绝不被 Auto 随后重开，手动打开
       * 的最终 tab 一律记为 manual 来源。
       */
      const sidebarManualIntentRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * Auto 动作串行闸门。
       *
       * 自动同步可能同时看到多个候选（多个运行中的子代理），但同一 tick 里连发多个
       * split()/openResource() 会互相抢 pane（第二个动作看到的 pane 证据仍是第一帧之前的）。
       * 因此一次只放行一个动作，动作收尾后由同一条同步链路推进下一个候选。
       */
      const sidebarAutoBusyRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
      /** 最近一次同步观察到的 Auto 开关值；变化时 bump 一次（空闲轮询绝不重渲染）。 */
      const sidebarAutoSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /**
       * 当前首次 split 的用户意图；它跨越 split → openResource → openTabs/DOM 提交窗口，
       * 只能在目标 tab 已经落到返回的 pane 后才交给 install 侧结算。
       */
      const sidebarSplitIntentRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /** 侧栏箭头动作的同 key 在途集合（打开/关闭共用一把锁）：重复点击只允许一次动作穿过。 */
      const sidebarTabPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 批量关闭动作的聚合锁，按 (sidebar session, root) 组合键隔离（主代理行 / 空闲分组标题行共用同一把）。
       *
       * 一次点击会顺序 await 多个 close(tabId)：整段序列在途期间必须拒绝第二次点击，否则双击会
       * 让同一个 tabId 被关闭两次（第二次必然抛错），也会让两次序列交错发出关闭请求。
       *
       * 锁键必须含 root + sidebar session，而不是一个组件级 boolean：宿主 close 返回的 Promise
       * 可能长时间不 settle，而用户完全可以在它挂起期间切换 root。单一 boolean 会让旧 root 的
       * 在途序列把**新 root** 的批量按钮一并置成 disabled —— 一次与它无关的切换被旧锁阻塞，
       * 且旧序列一旦永不 settle 就永久阻塞。集合里只保留仍在途的 scope，结算时精确删除自己那一项。
       */
      const sidebarBatchPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 批量关闭锁的复合键：当前 sidebar session + 当前 root。
       *
       * 两者缺一不可：同一个 root 的 root/child surface 各有自己的右栏，不同 root 更是完全独立的
       * surface；只有完全相同的两者才共享同一把锁（同一 scope 内 running/idle 两个批量入口互斥）。
       */
      const sidebarBatchScopeKey = (sessionId, rootId) => String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(rootId);
      /**
       * 最近一次同步算出的「批量候选 tabId 签名」。
       *
       * 主代理行与空闲分组标题行的批量控件/零圆点由渲染期现读的 openTabs inventory 决定，
       * 因此 inventory 变化必须触发一次重渲染——但 2.5 秒轮询在没有变化时绝不能再 bump，
       * 否则空闲时会变成定时重渲染。这里只在签名真的变化时 bump（见 syncSidebarTabs）。
       */
      const sidebarBatchSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /**
       * 最近一次渲染的右栏 tab 同步器（每次渲染同步写入，写法与 refreshRef 一致）。
       *
       * 挂载 effect 只在 sessionId/rootSessionId 变化时重建，而 observer / 轮询 / 可见性回调必须在
       * 「最近一次渲染」的闭包里执行——那里的 rootSessionId 与 sidebarRight 才是当前的。
       * 因此回调只读这个引用，绝不长期持有某一轮渲染的旧闭包。
       */
      const sidebarTabSyncRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      if (typeof react.useEffect === "function") {
        react.useEffect(() => {
          mountedRef.current = true;
          const refreshState = refreshStateRef.current;
          refreshState.rootSessionId = rootSessionId;
          refreshState.pending = false;
          void refresh();
          /**
           * sessions 通知：快照本身是**渲染输入**（第三行的权威 title、mode、activity 与目录项
           * 都来自 sessions 快照，且是在渲染期现读的），因此这条通知必须显式 bump 一次版本号
           * 触发一次重新渲染，不能只依赖 refresh 的状态写入。
           *
           * 原因：轮询空转时 refresh 会因「内容深度相等」直接 bail out（不再产生新状态），
           * 若这里不 bump，sessions 驱动的第三行更新就会跟着一起停掉。bump 与轮询无关：
           * 它只在宿主真的发布了新 sessions 快照时才发生，是事件驱动的必要重渲染。
           */
          const unsubscribe = subscribeSessions(config, contextRef.current, () => {
            bump((value) => value + 1);
            void refresh();
          });
          const poll = () => {
            // 右栏 tab 的外部关闭同步先跑：它不依赖页面可见性（隐藏标签页里用户也可能在别处关掉
            // 这个 tab），且没有任何打开记录时立刻返回，不触碰 DOM。
            sidebarTabSyncRef.current?.();
            try {
              if (globalThis.document?.hidden === true) return;
            } catch { /* 某些宿主 document 代理读取 hidden 会抛错，按可见处理。 */ }
            void refresh();
          };
          const timer = typeof globalThis.setInterval === "function" ? globalThis.setInterval(poll, 2500) : null;
          const documentRef = globalThis.document;
          const onVisibilityChange = () => {
            try {
              if (documentRef?.hidden !== true) {
                void refresh();
                // 回到前台时补一次同步：后台期间 MutationObserver 可能被浏览器节流。
                sidebarTabSyncRef.current?.();
              }
            } catch { /* 可见性通知只是加速恢复，读取失败不影响轮询。 */ }
          };
          try { documentRef?.addEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
          // 挂载（或切换 root 后重挂载）时立刻对齐一次：记录可能来自同一个 root 的上一个实例。
          sidebarTabSyncRef.current?.();
          /**
           * 外部关闭观察器：站在宿主已公开的 DOM 标记上观察，插件绝不改写宿主 DOM。
           *
           * 观察面固定为 document.body 子树而不是面板节点：右栏面板会迟到挂载（展开后才出现）、
           * 也会被宿主按 surface 整体重挂载，盯住具体节点会在重挂载后失联；而回调本身在没有任何
           * 打开记录时立即返回，空闲时（绝大多数时间）连一次 DOM 查询都不会发生。
           * 没有 MutationObserver / 没有 document.body / observe 抛错时静默降级为「只靠既有
           * 2.5 秒轮询与 visibilitychange 兜底」，绝不因为观察器缺失影响面板渲染。
           */
                     let unsubscribeOpenTabs = null;
           try {
             const inventory = sidebarRight?.openTabs ?? null;
             const subscribe = methodOf(inventory, "subscribe");
             if (subscribe !== null) {
               const cleanup = subscribe.call(inventory, () => { sidebarTabSyncRef.current?.(); });
               if (typeof cleanup === "function") unsubscribeOpenTabs = cleanup;
             }
           } catch { /* 旧宿主没有公开 inventory 或订阅失败时继续靠 observer/轮询。 */ }
           let tabObserver = null;
          try {
            const doc = globalThis.document;
            const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
            const target = doc?.body ?? null;
            if (typeof Observer === "function" && target !== null && target !== undefined) {
              tabObserver = new Observer(() => { sidebarTabSyncRef.current?.(); });
              tabObserver.observe(target, { childList: true, subtree: true });
            }
          } catch {
            try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
            tabObserver = null;
          }
          return () => {
            mountedRef.current = false;
            // 面板卸载 = 这一页不再由插件渲染：立刻把手柄交还宿主（无条件解锁，方向永远安全，
            // 重新挂载后的第一次同步会按宿主证据锁回去）。
            try { releaseRightbarDragLock?.(); } catch { /* 同上。 */ }
            const splitIntent = sidebarSplitIntentRef.current;
            sidebarSplitIntentRef.current = null;
            if (splitIntent !== null && cancelSidebarSplit !== null) {
              try { cancelSidebarSplit.call(config, splitIntent.token, { reason: "unmount" }); } catch { /* 事务收口失败不能阻断卸载。 */ }
            }
            requestSequenceRef.current += 1;
            refreshState.pending = false;
            refreshState.inFlight?.controller?.abort?.();
            refreshState.inFlight = null;
            if (typeof unsubscribe === "function") unsubscribe();
             if (typeof unsubscribeOpenTabs === "function") unsubscribeOpenTabs();
            if (timer !== null && typeof globalThis.clearInterval === "function") globalThis.clearInterval(timer);
            try { documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
            // 观察器必须与本次挂载同生共死：留一个仍在观察 body 的 observer 就是长期泄漏。
            try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
          };
        }, [rootSessionId, sidebarSessionId]);
      }
      const navigation = getOpenSession(config, contextRef.current);
      /**
       * 导航与侧栏动作依赖的可选服务（每个渲染帧解析一次，成本是可忽略的属性读取）。
       *
       * 候选顺序与 getOpenSession 一致：显式注入的 deps → tab 的 props.ctx → install ctx。
       * 三者都拿不到时保持 null：主视图导航退回旧接口，标题后箭头不渲染（绝不出现点了没反应的按钮）。
       */
      const serviceCandidates = [config, ctx, config.ctx];
      const sessionsService = resolveClientService(serviceCandidates, "sessions");
      const sidebarRight = resolveClientService(serviceCandidates, "sidebarRight");
      /**
       * install 侧注入的「右栏拖拽手柄锁」重估入口：真正的状态与 DOM 写入都在 install 闭包里
       * （只有它知道当前可见会话与宿主提交的活跃 tab），面板只负责在自己已有的观察/轮询
       * 生命周期上顺带请求一次。直接使用 createExpertGroupPanel 的宿主或测试没有这个入口，
       * 此时保持 no-op：面板渲染与交互逐字节不变。
       */
      const requestRightbarDragSync = typeof config.syncRightbarDragLock === "function" ? config.syncRightbarDragLock : null;
      /** 面板卸载时的无条件解锁入口（语义见 install 侧 releaseRightbarDragLock 的说明）。 */
      const releaseRightbarDragLock = typeof config.releaseRightbarDragLock === "function" ? config.releaseRightbarDragLock : null;
      /**
       * 首次 split 的宽度事务只由 install 侧协调：面板报告用户意图、split 回执和资源提交，
       * 自己不直接写 layout。没有 install 注入时保持旧宿主的 no-op 兼容路径。
       */
      const beginSidebarSplit = typeof config.beginSidebarSplit === "function" ? config.beginSidebarSplit : null;
      const markSidebarSplitPane = typeof config.markSidebarSplitPane === "function" ? config.markSidebarSplitPane : null;
      const markSidebarSplitOpen = typeof config.markSidebarSplitOpen === "function" ? config.markSidebarSplitOpen : null;
      const commitSidebarSplit = typeof config.commitSidebarSplit === "function" ? config.commitSidebarSplit : null;
      const cancelSidebarSplit = typeof config.cancelSidebarSplit === "function" ? config.cancelSidebarSplit : null;
      const openSidebarResource = methodOf(sidebarRight, "openResource");
      /**
       * Auto（自动打开运行中的子代理侧栏）的实时读面：install 注入的 getter，每次同步现读。
       *
       * 直接 createExpertGroupPanel（旧宿主/单测）没有该依赖时按**关闭**处理：默认行为必须
       * 与历史逐字节一致（不做任何自动 open/close）。读取抛错同样按关闭处理——自动行为只是
       * 体验增强，绝不能影响面板渲染或既有的手动箭头。
       */
      const readAutoOpenSetting = typeof config.getAutoOpenSubagentSidebar === "function"
        ? config.getAutoOpenSubagentSidebar
        : null;
      /** 面板标题栏 Auto 开关的写面；缺失时开关只读（渲染 disabled），绝不假装能改。 */
      const writeAutoOpenSetting = typeof config.setAutoOpenSubagentSidebar === "function"
        ? config.setAutoOpenSubagentSidebar
        : null;
      const autoOpenEnabled = () => {
        if (readAutoOpenSetting === null) return false;
        try { return readAutoOpenSetting() === true; } catch { return false; }
      };
      /**
       * 标题栏 Auto 开关的点击处理：先本地乐观翻转，再把显式布尔交给写面持久化。
       *
       * 写面缺失或返回非 true（只读文档、宿主校验/并发失败）时立刻清掉本地值，开关回退到权威读面；
       * 成功时本地值与读面一致，下一次同步观察到权威值变化会再清一次（幂等，绝不闪回）。
       */
      const toggleAutoOpen = (next) => {
        const value = next === true;
        if (writeAutoOpenSetting === null) return;
        setAutoOpenDraft(value);
        void Promise.resolve()
          .then(() => writeAutoOpenSetting(value))
          .then(
            (accepted) => { if (accepted !== true) setAutoOpenDraft(null); },
            () => { setAutoOpenDraft(null); },
          );
      };
      // 新版宿主提供公开 split()，返回新 pane 的 PaneId；只有拿到这个回执后才打开资源，
      // 避免 preferNewPane 失败时静默回落到 Expert Group 所在 pane。旧宿主没有 split() 时
      // 保留 preferNewPane 兼容路径，但绝不调用 float()，不制造用户可见浮窗。
      const splitSidebarPane = methodOf(sidebarRight, "split");
      // 可关闭 toggle 的两个方法能力：close() 负责关闭，active()/openTabs 提供「打开后真的落地了」的证据。
      // 两类确认能力都可能缺失（旧宿主），此时箭头退回静态 >> 打开行为，绝不猜 tabId。
      const closeSidebarResource = methodOf(sidebarRight, "close");
      // 宽度不足时 openResource 会按宿主契约回落到当前 pane；插件不调用 float，
      // 避免把用户的右栏页面变成独立悬浮窗口。右栏宽度策略在 install 侧统一处理。
      const readActiveSidebarResource = methodOf(sidebarRight, "active");
       /**
        * 读取公开 openTabs inventory：它按 Session 给出已提交 tab 的 tabId/kind/contentId，
        * 不依赖 active pane，因此宿主将焦点留在其它 pane/tab 时仍能确认目标子代理。
        * 旧宿主没有该 inventory 或读取失败时返回 null，调用方继续使用 active() 兼容路径。
        */
       const readSidebarOpenTabs = () => {
         let inventory = null;
         try { inventory = sidebarRight?.openTabs ?? null; } catch { return null; }
         const getSnapshot = methodOf(inventory, "getSnapshot");
         if (getSnapshot === null) return null;
         try {
           const snapshot = getSnapshot.call(inventory);
           return Array.isArray(snapshot) ? snapshot : null;
         } catch { return null; }
       };
       /**
        * split() 会按宿主 seed 规则先放入一个 guide tab。公开 openTabs 不带 paneId，
        * 只有同一 session 的 split 前后 tabId 差分中恰好一个新增 kind=guide，才足以唯一识别这次
        * 新建 pane 的种子；inventory 延迟、跨 session、并发新增多个 guide 或记录损坏时都 fail-closed，
        * 避免把其它并发提交的 tab 错当成 replaceTab。
        */
       const seededGuideTabId = (beforeTabs, sessionId) => {
         const expectedSessionId = text(sessionId, null);
         if (expectedSessionId === null || !Array.isArray(beforeTabs)) return null;
         const beforeIds = new Set();
         for (const tab of beforeTabs) {
           try {
             const candidate = object(tab);
             if (text(candidate.sessionId, null) !== expectedSessionId) continue;
             const tabId = text(candidate.tabId, null);
             if (tabId !== null) beforeIds.add(tabId);
           } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
         }
         const afterTabs = readSidebarOpenTabs();
         if (!Array.isArray(afterTabs)) return null;
         const newGuideTabIds = [];
         for (const tab of afterTabs) {
           try {
             const candidate = object(tab);
             if (text(candidate.sessionId, null) !== expectedSessionId
               || text(candidate.kind, null) !== "guide") continue;
             const tabId = text(candidate.tabId, null);
             if (tabId !== null && !beforeIds.has(tabId)) newGuideTabIds.push(tabId);
           } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
         }
         return newGuideTabIds.length === 1 ? newGuideTabIds[0] : null;
       };
             const sidebarOpenTabsAvailable = readSidebarOpenTabs() !== null;
                     const snapshot = viewState.snapshot;
       const sidebarSnapshotSyncRef = typeof react.useRef === "function"
         ? react.useRef({ rootSessionId, sidebarSessionId, snapshot })
         : { current: { rootSessionId, sidebarSessionId, snapshot } };
       if (typeof react.useEffect === "function") {
         react.useEffect(() => {
           const previous = sidebarSnapshotSyncRef.current;
           sidebarSnapshotSyncRef.current = { rootSessionId, sidebarSessionId, snapshot };
           if (previous.rootSessionId === rootSessionId
             && previous.sidebarSessionId === sidebarSessionId
             && previous.snapshot !== snapshot) sidebarTabSyncRef.current?.();
         }, [rootSessionId, sidebarSessionId, snapshot]);
       }
      const retry = () => { void refresh(); };
      const expand = (node) => store ? store.isExpanded(node) : (node?.kind === "root" || (typeof model.defaultExpanded === "function" && model.defaultExpanded(node)));
      const toggle = (node) => {
        if (store) store.toggle(node);
        bump((value) => value + 1);
      };
      /**
       * 打开会话的主视图导航（唯一入口：工作区服务的 `uiWorkspace.openSession`）。
       *
       * 已知子代理优先传 SubagentAddress（宿主据此恢复直系父与续跑能力，与 DSH 原生子代理行的
       * openChild 语义一致），地址缺失时传裸 session id。工作区入口不存在时这里不会被调用：
       * 渲染层在 `navigation.available !== true` 时不生成任何可点击的导航入口，绝不显示
       * 点了没反应的按钮。
       */
      const handleOpen = (id, address) => {
        if (navigation.available !== true) return;
        if (typeof id !== "string" || id.length === 0) return;
        navigation.open(address === null || address === undefined || navigation.acceptsAddress !== true ? id : address);
      };

      /**
       * 子代理地址解析（渲染层唯一的地址来源，主视图导航与侧栏箭头共用）。
       *
       * 1. `sessions.subagentAddress(childId)`：DSH 维护的「直系父会话 + 模式」权威地址，
       *    存在即优先使用；
       * 2. 会话投影目录项的合法 mode：目录已 hydration 时沿用 DSH 目录证据（含新增的
       *    `unknown`）。`unknown` 是合法地址值，但**不可续接**：它绝不被降级成
       *    continuable，宿主据此按只读呈现；
       * 3. 目录尚未 hydration 时，DEG Host 快照节点的 `continuable: true` 是本插件自身的
       *    明确证据，可与树遍历提供的 parentId 组成 continuable 地址。`false` 不映射为
       *    one-shot，避免把缺失/未知模式误当成合法地址；目录已有显式 mode（含 unknown）时
       *    保持该权威值，不被节点回退覆盖。
       * 4. 都拿不到时返回 null：主视图仍传裸 id，但绝不构造侧栏地址（避免打不开的地址）。
       */
      const subagentAddressOfChild = (childId, parentId, node) => {
        const id = text(childId, null);
        if (id === null) return null;
        const lookup = methodOf(sessionsService, "subagentAddress");
        if (lookup !== null) {
          let addressed;
          try { addressed = lookup.call(sessionsService, id); } catch { addressed = null; }
          const normalized = normalizeSubagentAddress(addressed);
          if (normalized !== null) return normalized;
          // undefined/null 表示地址尚未被 DSH 发现，允许继续走 Host 快照兜底；
          // 宿主若已经返回了非空但非法对象，则保守拒绝，不能用较弱证据覆盖坏地址。
          if (addressed !== undefined && addressed !== null) return null;
        }
        const parent = text(parentId, null);
        const entry = catalogEntryOf(parent, id);
        const entrySource = object(entry);
        const entryHasMode = Object.prototype.hasOwnProperty.call(entrySource, "mode");
        const entryMode = text(entrySource.mode, null);
        // DSH 目录懒加载时 entry 可能暂时不存在，或投影项尚未带 mode 字段；DEG 的 Host
        // 快照已明确证明其 child 是 continuable，此证据足以构造同一规范地址。只对 true 回退，
        // false 仍表示未知；若目录显式带了 mode（含 unknown 或非法值），则保留目录权威值，
        // 绝不用较弱证据把它说成可续接。
        const mode = entryHasMode
          ? entryMode
          : (object(node).continuable === true ? "continuable" : null);
        return normalizeSubagentAddress({
          parentSessionId: parent,
          childSessionId: id,
          mode,
        });
      };

      /**
       * 标题后「在右侧栏打开」箭头按钮：与 DSH 原生子代理行同款（IconChevronRightOutlineRegular）。
       *
       * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名箭头图标可用。
       * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
       *
       * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
       * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
       * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
       * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
       * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
       * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
       * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
       * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
       * 必须同时存在：鼠标事件不得冒泡到任务名/第三行的导航处理器，键盘 Enter/Space 在按钮上的
       * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
       * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
       */
      /**
       * 当前 active tab 的 id（读面缺失、读取或调用抛错、没有 tab 时一律返回 null）。
       *
       * 只用于「正向存在证据」：active() 返回的目标 tabId 说明宿主的存储里这个 tab 还在。
       * 反过来不成立——active() 返回别的 tab 只说明用户切到了别的 tab/pane，绝不能当作
       * 「目标 tab 没了」的证据去复位或关闭。
       */
      const activeSidebarTabId = () => {
        if (readActiveSidebarResource === null) return null;
        try { return text(object(readActiveSidebarResource.call(sidebarRight)).id, null); } catch { return null; }
      };

      /**
       * 当前右栏面板里所有 tab 的 id 集合。
       *
       * 读不到「当前右栏面板」（折叠、surface 切换中、宿主还没挂载）、没有 DOM 查询能力、
       * 或查询抛错时统一返回 null——调用方据此保持现有状态。空 Set 表示「面板在、但确实没有
       * 任何 tab」，那是真实的缺失证据，不是「读不到」。
       */
      const presentSidebarTabIds = () => {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        // 只读当前 session 自己的面板：零个匹配（还没挂载 / 不属于这一页）或归属不明确时返回 null，
        // 调用方保持现状；绝不退回 DOM 第一个面板——别的会话残留的面板会把它的 tab 当成
        // 本会话的缺失证据，从而误判「用户收回了 tab」。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined) return null;
        if (typeof panel.querySelectorAll !== "function") return null;
        let nodes = null;
        try { nodes = panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR); } catch { return null; }
        if (nodes === null || nodes === undefined) return null;
        let entries = [];
        try { entries = Array.from(nodes); } catch { return null; }
        const ids = new Set();
        for (const node of entries) {
          let raw = null;
          try { raw = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { raw = null; }
          const id = text(raw, null);
          if (id !== null) ids.add(id);
        }
        return ids;
      };

      /**
       * 找到包含指定 tab 的 DockKit pane。
       *
       * openTabs 公开读面只给 tabId/kind/contentId，不提供 paneId；而 openResource 在没有 paneId
       * 且无法再 split 时会回落到 active pane。这里仅读取宿主已经渲染的
       * data-dockkit-pane / data-dockkit-tab 标记，不改 DOM，也不调用宿主内部 split。
       */
      const paneIdsContainingTabs = (panel, tabIds, extraMatcher = null) => {
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
        let nodes;
        try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return new Set(); }
        const paneIds = new Set();
        for (const node of nodes) {
          let rawTabId = null;
          try { rawTabId = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { rawTabId = null; }
          const tabId = text(rawTabId, null);
          const matched = tabIds.has(tabId) || (typeof extraMatcher === "function" && extraMatcher(tabId));
          if (!matched) continue;
          const visited = new Set();
          let parent = null;
          try { parent = node?.parentElement ?? node?.parentNode ?? null; } catch { parent = null; }
          while (parent !== null && parent !== undefined && !visited.has(parent)) {
            visited.add(parent);
            let rawPaneId = null;
            try {
              rawPaneId = typeof parent.getAttribute === "function"
                ? parent.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
                : null;
            } catch { rawPaneId = null; }
            const paneId = text(rawPaneId, null);
            if (paneId !== null) {
              paneIds.add(paneId);
              break;
            }
            try { parent = parent.parentElement ?? parent.parentNode ?? null; } catch { parent = null; }
          }
        }
        return paneIds;
      };

      /**
       * 读取某个真实 tab 所在的 DockKit pane。只接受 DOM 明确给出的 paneId；
       * openTabs 没有 paneId 时，inventory 本身不能证明资源没有回落到 Expert Group pane。
       */
      const paneIdContainingTab = (tabId) => {
        const doc = globalThis.document;
        if (doc === null || doc === undefined || typeof doc.querySelector !== "function") return null;
        // 与 existingSubagentPaneId 同源：只认当前 session 面板里的 data-dockkit-pane 标记。
        // 面板解析不出来（读面缺失或归属不明确）时返回 null，split 提交证据继续 fail-closed，
        // 绝不把别的 session 的 paneId 当成「目标资源已经落到本次 split 的 pane」的证据。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined) return null;
        const paneIds = paneIdsContainingTabs(panel, new Set([tabId]));
        return paneIds.size === 1 ? [...paneIds][0] : null;
      };

      /**
       * 目标资源的精确提交证据：同一 surface、subagentchat kind、同一 contentId，
       * 并且 DOM 把该 tab 放在本次 split 返回的 pane 中。guide、active-only 或错误 pane
       * 都会继续等待，不会把临时 50% 状态提交成 other 模式。
       */
      const sidebarSplitTargetEvidence = (resourceAddress, expectedPaneId = null) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return null;
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.contentId, null) !== resourceAddress) continue;
            const tabId = text(candidate.tabId, null);
            if (tabId === null) continue;
            const paneId = paneIdContainingTab(tabId);
            if (paneId === null) continue;
            // 同地址可以短暂存在多个 tab：首条记录可能还在旧 pane，必须继续搜索，
            // 直到找到真正落在本次 split 返回 pane 的候选，避免错误 pane 永久遮蔽正确证据。
            if (expectedPaneId !== null && paneId !== expectedPaneId) continue;
            return { tabId, paneId };
          } catch {
            // 单条 inventory 损坏时继续检查其余记录。
          }
        }
        return null;
      };

      /**
       * 读取当前 DOM 中 Expert Group 所在的 pane 集合。
       *
       * 这个集合只由公开的 tab/pane 标记构成：inventory 用来把 kind 映射成真实 tabId，
       * DOM 用来确认 tab 的实际 pane。没有证据时返回空集合，调用方必须保持 fail-closed。
       */
      const expertGroupPaneIds = (panel) => {
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
        // tabId 集合来自共享读面 helper（与分栏配比那条路径同源，避免两处判定漂移）。
        return paneIdsContainingTabs(
          panel,
          expertGroupTabIdsOf(readSidebarOpenTabs(), sidebarSessionId),
          isGeneratedExpertGroupTabId,
        );
      };

      /**
       * 解析已有的子代理目标 pane。
       *
       * 首次打开时只有 Expert Group pane，返回 null 让打开流程通过公开 split() 创建子代理 pane；
       * 已经存在多个 pane 时，选最右侧且不包含 Expert Group 的 pane，并显式传给 openResource。
       * 这样后续所有 >> 都复用同一个右侧 pane，不会因为 active pane 恰好在左侧而回落到左侧。
       * DOM 读面缺失、pane/tab 结构不完整或查询抛错时统一返回 null，保留旧宿主兼容语义。
       */
      const existingSubagentPaneId = () => {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        // 归属边界：pane 只能从**当前 session 自己的面板**里复用。同一次 install 里 DOM 可能同时
        // 残留多个 session 的面板（React 重挂载窗口），querySelector 的首个命中无法证明归属；
        // 解析不出来时保持 null，让打开流程决定是先 split 还是走旧宿主兼容分支——绝不把别的
        // session 的 paneId 传给 openResource（那会让资源落到别人的右栏布局上）。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
        const expertPaneIds = expertGroupPaneIds(panel);
        // 没有任何证据证明哪个 pane 是 Expert Group 时，不能把最右 pane 猜成安全目标；
        // 保持 null，让打开流程决定是调用公开 split() 还是走旧宿主兼容分支。
        if (expertPaneIds.size === 0) return null;
        // 候选 pane 与它们的 DOM 顺序/列号：这里刻意只用 pane 标识与列号判定（pane 读面本身
        // 读不到时才 fail-closed），绝不复用分栏配比那条更严的 pane 组成读面——否则一个读不到
        // tabId 的 pane 就会让「复用已有子代理 pane」退化成再 split 一个新 pane。
        const panes = paneNodesOf(panel);
        if (panes === null) return null;
        const candidates = [];
        for (let index = 0; index < panes.length; index += 1) {
          const pane = panes[index];
          let rawPaneId = null;
          try {
            rawPaneId = typeof pane?.getAttribute === "function"
              ? pane.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
              : null;
          } catch { rawPaneId = null; }
          const paneId = text(rawPaneId, null);
          if (paneId === null || expertPaneIds.has(paneId)) continue;
          let rawColumn = null;
          try {
            rawColumn = typeof pane?.getAttribute === "function"
              ? pane.getAttribute(RIGHTBAR_PANE_COLUMN_ATTRIBUTE)
              : null;
          } catch { rawColumn = null; }
          const columnText = text(rawColumn, null);
          const column = columnText === null ? null : Number(columnText);
          candidates.push({ paneId, column: Number.isFinite(column) ? column : null, index });
        }
        candidates.sort((left, right) => {
          if (left.column !== null && right.column !== null && left.column !== right.column) {
            return right.column - left.column;
          }
          if (left.column !== null && right.column === null) return -1;
          if (left.column === null && right.column !== null) return 1;
          return right.index - left.index;
        });
        return candidates[0]?.paneId ?? null;
      };

      /**
       * 右栏 tab 外部关闭同步与浮动存在性查询的判定边界（供下方 helper 与同步器使用）。
       *
       * 停靠 tab 节点或匹配的浮动 subagentchat 标题是存在性证据；active() 返回目标 tab 是
       * 额外的正向证据。判定与动作边界：
       * - 没有任何打开记录时立即返回，连 DOM 查询都不做（空闲路径零成本）；
       * - 没有 DOM 证据（无 document / 无面板 / 查询能力缺失 / 查询抛错）时保持现有状态，
       *   绝不在缺少证据时复位——折叠右栏、切换 surface、面板重挂载都会短暂读不到面板；
       * - 只检查当前 root 的记录：root 切换或卸载时，别的会话的记录原样保留（更不会去关闭它的 tab）；
       * - 目标 tab 连续 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS 次被观测到缺失才删除记录并 bump，
       *   任何一次正向证据都会把计数清零（防止把宿主提交窗口的中间态误判成用户关闭）；
       * - 这里只改插件自己的记录，绝不调用 close()：外部关闭已经发生，再关一次是多余且危险的。
       */
      const presentFloatingSubagentTitles = () => {
         const doc = globalThis.document;
         if (!doc || typeof doc.querySelectorAll !== "function") return null;
         let floats = null;
         try { floats = Array.from(doc.querySelectorAll(RIGHTBAR_FLOAT_SELECTOR)); } catch { return null; }
         const titles = new Set();
         for (const float of floats) {
           if (typeof float?.querySelector !== "function") return null;
           let chat = null;
           let titleNode = null;
           try {
             chat = float.querySelector("[data-sidebar-chat]");
             titleNode = float.querySelector(RIGHTBAR_FLOAT_TITLE_SELECTOR);
           } catch { return null; }
           if (chat === null || titleNode === null) continue;
           const title = text(titleNode.textContent, null);
           if (title !== null) titles.add(title);
         }
         return titles;
       };

       /**
        * 外部关闭同步（低成本、幂等、绝不抛错）。
        *
        * 停靠 tab 通过宿主渲染的 tabId 标记观察，浮动 tab 通过 subagentchat body 与打开时标题做
        * 保守正向匹配；active() 返回目标 tab 也是正向证据。面板、浮动查询或任何 DOM 能力缺失时
        * 保持现有状态，绝不把焦点切换或 surface 过渡猜成关闭。
        */
              const knownSidebarResourceAddresses = () => {
         const addresses = new Set();
         const add = (node, parentId) => {
           const source = object(node);
           if (source.kind === "fanout") {
             const shards = Array.isArray(source.shards) ? source.shards : [];
             for (const shard of shards) {
               const shardSource = object(shard);
               const childId = text(shardSource.childId, null);
               if (childId === null) continue;
               const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, {
                 ...shardSource,
                 kind: "expert",
               }));
               if (address !== null) addresses.add(address);
             }
           } else {
             const childId = text(source.sessionId, text(source.childId, null));
             if (childId !== null) {
               const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, source));
               if (address !== null) addresses.add(address);
             }
           }
           if (Array.isArray(source.children)) {
             for (const child of source.children) add(child, parentId);
           }
         };
         const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
         for (const child of children) add(child, rootSessionId);
         return addresses;
       };
      /**
       * 当前 root 专家树里的「运行中」资源地址（普通专家、嵌套专家与最新 fan-out 分片）。
       *
       * 与 renderThreeLines 使用**同一个**规范地址 helper（subagentAddressOfChild + subagentChatAddress），
       * 因此批量候选与单会话箭头指向的是同一个 contentId，绝不存在第二套地址推导。
       *
       * 纳入条件只有一条：runtimeStatusOfNode(...) === "running"（与行内圆点、第三行摘要同源）。
       * ready/unknown 一律不纳入——未知状态绝不混进「可以关闭」的集合，空闲专家由空闲分组单独负责。
       *
       * parent 证据缺失或非法时 fail-closed：subagentAddressOfChild 会返回 null，该节点直接跳过，
       * 绝不用猜测的 parent 补出一个地址（猜出来的地址可能关掉另一个会话的 tab）。
       */
      const sidebarExpertResourceAddresses = (node, parentId, addresses) => {
        const source = object(node);
        const kind = text(source.kind, null);
        if (kind === "fanout") {
          const shards = Array.isArray(source.shards) ? source.shards : [];
          for (const shard of shards) {
            const shardSource = object(shard);
            // 只认最新 attempt 的 childId：旧 attempt 的子会话不再由这一行代表，也不是可导航目标。
            const childId = text(shardSource.childId, null);
            if (childId === null) continue;
            if (runtimeStatusOfNode(shardSource, parentId, childId) !== "running") continue;
            const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, {
              ...shardSource,
              kind: "expert",
            }));
            if (address !== null) addresses.add(address);
          }
          return;
        }
        if (kind !== "expert") return;
        const childId = text(source.sessionId, text(source.childId, null));
        if (childId !== null && runtimeStatusOfNode(source, parentId, childId) === "running") {
          const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, source));
          if (address !== null) addresses.add(address);
        }
        // 嵌套专家：parent 就是它的宿主专家会话；宿主缺失时内层地址推导 fail-closed。
        if (Array.isArray(source.children)) {
          for (const child of source.children) sidebarExpertResourceAddresses(child, childId, addresses);
        }
      };

      /** 当前快照的 root 直接子节点（快照缺失时为空数组）。 */
      const sidebarRootChildren = () => (Array.isArray(snapshot?.root?.children) ? snapshot.root.children : []);

      /**
       * 空闲分组收纳 ready 直接专家和已结算的 fan-out 父任务。
       * 父任务必须命中 manager 终态，不能仅凭子会话暂时未运行或未知状态提前移动。
       */
      const sidebarIdleChildren = () => sidebarRootChildren()
        .filter((node) => {
          if (node.kind === "fanout") return FANOUT_SETTLED_STATUSES.has(statusOf(node));
          return node.kind === "expert"
            && runtimeStatusOfNode(node, rootSessionId, text(node.sessionId, null)) === "ready";
        });

      /**
       * 当前 root 专家树里「运行中」的资源地址集合（主代理行批量关闭的唯一候选来源）。
       * 与空闲分组互斥：这里只遍历 root.children 中的专家/fan-out 节点，空闲成员不参与。
       */
      const runningSidebarResourceAddresses = () => {
        const addresses = new Set();
        for (const child of sidebarRootChildren()) sidebarExpertResourceAddresses(child, rootSessionId, addresses);
        return addresses;
      };

      /**
       * 空闲分组的资源地址集合；成员判定严格复用当前 idleChildren。
       * fan-out 父任务代表其最新 attempt 的分片会话，只收录当前未运行的会话地址。
       */
      const idleSidebarResourceAddresses = (nodes) => {
        const addresses = new Set();
        for (const node of Array.isArray(nodes) ? nodes : []) {
          const source = object(node);
          if (source.kind === "fanout") {
            for (const shard of Array.isArray(source.shards) ? source.shards : []) {
              const shardSource = object(shard);
              const shardChildId = text(shardSource.childId, null);
              if (shardChildId === null || runtimeStatusOfNode(shardSource, rootSessionId, shardChildId) !== "ready") continue;
              const shardAddress = subagentChatAddress(subagentAddressOfChild(shardChildId, rootSessionId, {
                ...shardSource,
                kind: "expert",
              }));
              if (shardAddress !== null) addresses.add(shardAddress);
            }
            continue;
          }
          const childId = text(source.sessionId, text(source.childId, null));
          if (childId === null) continue;
          const address = subagentChatAddress(subagentAddressOfChild(childId, rootSessionId, source));
          if (address !== null) addresses.add(address);
        }
        return addresses;
      };

      /**
       * 一次批量动作的候选集合：当前 openTabs inventory ∩ 给定的规范地址集合。
       *
       * 匹配条件缺一不可（全部来自公开只读 inventory 的字段）：
       * - candidate.sessionId === 当前 sidebar session：绝不操作别的 surface 的 tab；
       * - kind === "subagentchat"：同 session 下别的 kind 不是本插件的资源；
       * - tabId 与 contentId 都非空：缺任何一个都无法精确关闭，也就没有可关闭的候选；
       * - contentId 精确等于集合中的地址：同一个 kind 下也可能是另一个子代理的地址。
       *
       * 结果按 tabId 去重：宿主 inventory 理论上可能有重复记录，重复 tabId 只能关一次。
       */
      const sidebarBatchCandidates = (addresses, inventory) => {
        const seen = new Set();
        const candidates = [];
        for (const entry of inventory) {
          // 单条损坏记录（getter 抛错、非对象、缺字段）只跳过这一条：其余可关闭的 tab 照旧成候选。
          let candidate = null;
          try {
            candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            const tabId = text(candidate.tabId, null);
            if (tabId === null) continue;
            const contentId = text(candidate.contentId, null);
            if (contentId === null || addresses.has(contentId) !== true) continue;
            if (seen.has(tabId) === true) continue;
            seen.add(tabId);
            candidates.push(tabId);
          } catch { continue; }
        }
        return candidates;
      };

      /**
       * 两类标题行的批量状态（渲染期纯读，一次渲染只算一次）。
       *
       * 四态语义严格区分「未知」「零」「有候选但关不掉」：
       * - inventory 读不出来（旧宿主 / 读面抛错 / 非数组）→ kind "none"：不渲染零圆点、也不渲染按钮；
       * - inventory 已知是数组且候选数为 0 → kind "zero"：非交互蓝色实心圆占位（需要左箭头图标可用）。
       *   零状态只由「候选集合为空」决定，**不依赖 close 能力**：本行确实没有可关闭的会话时，
       *   蓝点表达的就是这个事实，与宿主能否关闭无关；
       * - 候选数 > 0 且 close 能力可用 → kind "close"：可点击的双左尖括号批量关闭按钮；
       * - 候选数 > 0 但 close 不可用 → kind "none"：既不能误报「零」（inventory 里明明有本行的
       *   打开会话），也绝不渲染一个点了不会关的假按钮，这一行整个不出现行尾控件。
       *
       * 判定的顺序有实质意义：必须先算候选再看 close 能力。反过来（先看 close）会把「有候选但
       * 关不掉」误判成「零」，那正是蓝点最不该出现的场合。
       */
      const sidebarBatchStateFor = (addresses) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return { kind: "none", candidates: [] };
        const candidates = sidebarBatchCandidates(addresses, inventory);
        if (candidates.length === 0) return { kind: "zero", candidates: [] };
        if (closeSidebarResource === null) return { kind: "none", candidates: [] };
        return { kind: "close", candidates };
      };

      /**
       * 两行批量状态的合并签名：只在候选集合真的变化时触发一次重渲染（空闲轮询绝不空转重渲染）。
       * 两行必须一起进签名——只跟踪主代理行会让空闲分组的手动开/关 tab 迟迟不被反映。
       */
      const sidebarBatchSignatureOf = (runningState, idleState) => {
        const part = (state) => (state.kind === "close" ? "close:" + state.candidates.join(",") : state.kind);
        return part(runningState) + "|" + part(idleState);
      };

      /**
       * 等宿主完成一次布局提交，再读取 DockLayout 的可分栏判定。
       *
       * `layout.panels` 的 setRightbar action 只同步派发 store 更新；真实宿主的 `DockLayout`
       * 通过 React 提交后才会更新 `onRoom` 读面，而 `sidebarRight.split()` 会立即读取这个
       * 读面。若在同一调用栈内 split，宿主仍可能看到旧的窄栏并弹出「栏宽不足」。
       * 优先使用 RAF，让 React 的 layout effect 和浏览器布局先完成；无 RAF 的旧宿主退回
       * 一个宏任务，再退回 microtask。这个等待只发生在新版 install 注入的 split 事务里，
       * 旧宿主没有事务入口时仍保持原同步兼容路径。
       */
      const waitForSidebarSplitLayoutCommit = () => new Promise((resolve) => {
        let settled = false;
        let fallbackTimer = null;
        const clearFallback = () => {
          if (fallbackTimer === null) return;
          try { globalThis.clearTimeout?.(fallbackTimer); } catch { /* 清理失败时 callback 仍会由 settled 防重。 */ }
          fallbackTimer = null;
        };
        const settle = () => {
          if (settled) return;
          settled = true;
          clearFallback();
          resolve();
        };
        const scheduleFallback = (delay) => {
          try {
            const setTimeout = globalThis.setTimeout;
            if (typeof setTimeout !== "function" || settled) return false;
            fallbackTimer = setTimeout(settle, delay);
            return true;
          } catch {
            return false;
          }
        };
        try {
          const requestAnimationFrame = globalThis.requestAnimationFrame;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => settle());
            // 视觉帧可能被后台标签页节流；fallback 只负责结束等待，随后仍由事务检查决定是否 split。
            if (scheduleFallback(SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS)) return;
          }
        } catch { /* 继续尝试不依赖视觉帧的宿主调度器。 */ }
        if (scheduleFallback(0)) return;
        try {
          const queueMicrotask = globalThis.queueMicrotask;
          if (typeof queueMicrotask === "function") {
            queueMicrotask(settle);
            return;
          }
        } catch { /* 最后的同步收口保证 Promise 不会永久悬挂。 */ }
        settle();
      });

      /**
       * 子代理页必须先通过公开 split() 获得独立 paneId，再由 openResource 显式定位；split() 明确
       * 失败时不打开资源，避免回落到 Expert Group pane。旧宿主没有 split() 时保留 preferNewPane
       * 兼容路径。这里不调用 float，因为 float 的用户可见结果是独立窗口。
       */

      /**
       * 清理当前 split 事务；失败时由 install 侧按实际 pane 组成决定是否恢复 20%。
       *
       * 同一个 key 的「在途打开记录」与 split 意图属于同一次点击：事务一旦收口，那次打开就不该
       * 再被后续同步当成「还没确认的打开」而重建关闭记录（用户明明已经收回了这个 tab）。因此这里
       * 一并删除该 key 的 opening 记录；意图缺失时它是一次幂等空操作。
       */
      const cancelPendingSidebarSplit = (reason) => {
        const intent = sidebarSplitIntentRef.current;
        if (intent === null) return;
        sidebarSplitIntentRef.current = null;
        // 意图里带着 key，收口范围因此精确到这一次点击，绝不误伤别的行的在途记录。
        sidebarTabOpeningRef.current.delete(intent.key);
        if (cancelSidebarSplit === null) return;
        try { cancelSidebarSplit.call(config, intent.token, { reason }); } catch { /* 收口失败不能阻断面板同步。 */ }
      };

      /**
       * 只有 inventory 与 DOM 同时证明目标资源位于本次返回的 pane，才结束临时扩栏事务。
       * 该检查复用已有 observer、可见性回调和轮询，不另挂长期 observer。
       */
      const tryCommitSidebarSplit = () => {
        const intent = sidebarSplitIntentRef.current;
        if (intent === null || intent.resourceIssued !== true || commitSidebarSplit === null) return;
        const evidence = sidebarSplitTargetEvidence(intent.resourceAddress, intent.paneId);
        if (evidence === null) return;
        try {
          if (commitSidebarSplit.call(config, intent.token, evidence) === true) {
            sidebarSplitIntentRef.current = null;
          }
        } catch {
          // 宿主提交窗口仍可能在下一次 observer/轮询中完成，保留事务继续等待。
        }
      };

      /**
       * 第一阶段：既有「右栏 tab 记录/库存同步」（外部关闭观察、在途打开结算、批量签名更新）。
       *
       * 它保留了原有的提前 return（records 为空时不做任何 DOM 查询）；自动同步因此被拆到
       * 独立的第二阶段（syncSidebarTabs），那些短路不会再吞掉自动打开/关闭。
       */
      const syncSidebarTabRecords = () => {
        // 右栏拖拽手柄锁复用这条既有生命周期（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）：
        // 活跃 tab 一变就重估，绝不为它单独再挂一个长期 observer。请求失败只影响这一次重估。
        try { requestRightbarDragSync?.(); } catch { /* 手柄锁只是体验优化，绝不影响面板。 */ }
        /**
         * 标题行批量控件/零圆点由渲染期现读的 openTabs inventory 决定，因此这里必须在**任何提前 return
         * 之前**比较一次候选签名：records 为空时旧实现会直接返回，inventory 变化就再也不会被反映，
         * 用户手动打开的 tab（没有本插件的打开记录）也会永远看不到可关闭的批量按钮。
         *
         * 只有签名真的变化才 bump：2.5 秒轮询在没有变化时绝不产生重渲染。
         */
        const batchSignatureNow = sidebarBatchSignatureOf(
          sidebarBatchStateFor(runningSidebarResourceAddresses()),
          sidebarBatchStateFor(idleSidebarResourceAddresses(sidebarIdleChildren())),
        );
        if (sidebarBatchSignatureRef.current !== batchSignatureNow) {
          sidebarBatchSignatureRef.current = batchSignatureNow;
          bump((value) => value + 1);
        }
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
         const now = Date.now();
                   const openingResolved = [];
          if (records.size === 0) {
            for (const resourceAddress of knownSidebarResourceAddresses()) {
              const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
              if (recordSidebarTab(key, resourceAddress)) openings.delete(key);
            }
          }
         for (const [key, opening] of openings) {
           if (now >= opening.expiresAt) {
             if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("timeout");
             openingResolved.push(key);
             continue;
           }
           if (opening.sessionId !== sidebarSessionId || opening.rootSessionId !== rootSessionId) continue;
           if (recordSidebarTab(key, opening.resourceAddress)) openingResolved.push(key);
         }
         for (const key of openingResolved) {
           openings.delete(key);
         }
         // 先完成精确 split 提交，再执行关闭同步；guide-only 或错误 pane 仍继续等待。
         tryCommitSidebarSplit();
         /**
          * 手动意图的兜底结算扫描（在任何提前 return 之前）：
          * 在途动作收尾、打开记录落地或超时都可能让一个意图变成可结算状态。数量级等于用户点击次数，
          * 因此每轮扫描的成本可以忽略；仍然在途的意图由 applyPendingManualIntent 自己跳过。
          * 别的 session/root 的条目在这里永远结算不了（它属于那个 surface 自己的闭包），直接删除，
          * 保证面板跨 root 复用时不泄漏手动意图。
          */
         for (const key of [...sidebarManualIntentRef.current.keys()]) {
           const entry = sidebarManualIntentRef.current.get(key);
           if (entry === undefined) continue;
           if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) {
             sidebarManualIntentRef.current.delete(key);
             continue;
           }
           applyPendingManualIntent(key);
         }
         // 先完成打开记录，再执行关闭同步；同 pane 回落不再被转换成独立浮窗。
         // 这里保留「没有打开记录就直接返回」的既有短路（它保证空闲时不会发生任何 DOM 查询）；
         // 批量控件的聚合状态更新已经在**这个短路之前**完成，因此 records 为空时 inventory 的变化
         // 照旧能被反映，而用户手动打开的 tab 也不再依赖本插件的打开记录。
         if (records.size === 0) return;
        const present = presentSidebarTabIds();
        if (present === null) return;
        const floatingTitles = presentFloatingSubagentTitles();
         if (floatingTitles === null) return;
         const activeTabId = activeSidebarTabId();
        const stale = [];
        for (const [key, record] of records) {
          if (record.sessionId !== sidebarSessionId || record.rootSessionId !== rootSessionId) continue;
          if (present.has(record.tabId) === true
             || record.tabId === activeTabId
             || (text(record.title, null) !== null && floatingTitles.has(record.title))) {
            record.misses = 0;
            continue;
          }
          record.misses += 1;
          if (record.misses >= SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS) stale.push(key);
        }
        if (stale.length === 0) return;
        for (const key of stale) {
          // 外部关闭同步只维护「这个 tab 还在不在」的记录：宽度不再随 tab 开关变化。
          records.delete(key);
        }
        bump((value) => value + 1);
      };

      /**
       * 当前 sidebar session 的公开 inventory 里，某个资源地址对应的已提交 tabId。
       *
       * 返回值必须区分两种「没有」——这是能力降级 fail-closed 的唯一判据：
       * - readable === false：inventory 不可读（旧宿主 / 读取抛错）。此时既证明不了资源已打开，
       *   也证明不了它没打开，调用方一律不得据此自动打开（否则可能开出重复页）；
       * - readable === true && tabId === null：读到了 inventory，确认这个地址没有已提交 tab。
       * 判定字段与 recordSidebarTab 逐条同源（同 session、kind、contentId），因此「自动打开前的
       * 存在性检查」与「关闭用的 tabId」永远来自同一个来源，绝不按「当前 active 是谁」猜 tab。
       */
      const sidebarResourceTabStateOf = (resourceAddress) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return { readable: false, tabId: null };
        for (const entry of inventory) {
          const candidate = object(entry);
          if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
          if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
          if (text(candidate.contentId, null) !== resourceAddress) continue;
          return { readable: true, tabId: text(candidate.tabId, null) };
        }
        return { readable: true, tabId: null };
      };
      /**
       * active() 是否已经是这个资源（kind 与 contentId 同时匹配）。
       *
       * inventory 不可读或提交延迟时，它仍能证明「这个资源已经开着」：这样的 tab 只算手动/未知
       * 来源，Auto 既不接管（不写 auto 来源）也不重复打开；它只在「可追踪」判定里作为证据使用。
       */
      const sidebarActiveResourceMatches = (resourceAddress) => {
        if (readActiveSidebarResource === null) return false;
        let tab = null;
        try { tab = object(readActiveSidebarResource.call(sidebarRight)); } catch { return false; }
        if (text(tab.kind, null) !== SUBAGENT_CHAT_KIND) return false;
        return text(tab.contentId, null) === resourceAddress;
      };
      /**
       * 自动打开必须同时具备的能力（缺一项即 fail-closed，绝不自动打开）：
       * 1. 公开 close()：没有它，Auto 打开的 tab 将来无法被精确回收（只能用 tabId 关闭，绝不改用
       *    批量入口或按 active 猜）；
       * 2. 落地证据读面（active() 或 openTabs inventory）与左箭头图标：没有证据就无法确认这次打开
       *    有没有落地，也就没有可关闭的 << 状态；
       * 3. 公开 openResource()：没有它连打开动作都发不出去。
       * 只约束自动路径：这些能力缺失时手动箭头与历史行为逐条不变。
       */
      const sidebarAutoOpenCapable = () => openSidebarResource !== null
        && closeSidebarResource !== null
        && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
        && typeof primitives?.IconChevronLeftOutlineRegular === "function";

      /** 当前 surface 自己的手动意图记录；别的 session/root 的键在当前闭包里一律不可见。 */
      const sidebarManualIntentOf = (key) => {
        const entry = sidebarManualIntentRef.current.get(key);
        if (entry === undefined) return undefined;
        if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) return undefined;
        return entry;
      };
      /**
       * Auto 同步第二阶段的候选选择：先给一个「该关的」候选，再给一个「该开的」候选。
       *
       * 一个同步轮次最多产出一个候选（见 sidebarAutoBusyRef）：多个候选由动作收尾后的同一条
       * 同步链路逐个推进，绝不并发发多个 split/openResource。
       */
      const autoCloseCandidate = (running) => {
        const origin = sidebarAutoOriginRef.current;
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
        const attempts = sidebarAutoCloseAttemptsRef.current;
        for (const [key, entry] of origin) {
          // 只处理当前 surface 的记账：别的 session/root 的键在当前快照里无法判定，绝不越权操作。
          if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
          if (running.has(entry.address) === true) {
            // 资源重新变成运行中：它已经开着就保持开着，重试记账一并清零。
            attempts.delete(key);
            continue;
          }
          const record = records.get(key);
          const scopedRecord = record !== undefined
            && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId
            ? record
            : undefined;
          if (scopedRecord === undefined) {
            // 没有已确认的 tabId 时绝不猜一个 id 去关：这次打开仍在途就继续等它落地，
            // 否则只撤销来源标记（元素已经不在这个 surface 上了）。
            const opening = openings.get(key);
            if (opening !== undefined && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId) continue;
            if (sidebarTabPendingRef.current.has(key) === true) continue;
            origin.delete(key);
            attempts.delete(key);
            continue;
          }
          if (scopedRecord.origin !== SIDEBAR_TAB_ORIGIN_AUTO) {
            // 记录已经被手动接管（用户手动打开或外部 tab）：手动优先，撤销自动来源，绝不关闭它。
            origin.delete(key);
            attempts.delete(key);
            continue;
          }
          if (closeSidebarResource === null) {
            // 宿主没有公开 close（旧宿主）：撤销记账，绝不退化成别的关闭方式。
            origin.delete(key);
            attempts.delete(key);
            continue;
          }
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          // 本次级联里已经为它尝试过并失败：同一批微任务里绝不重试（见 sidebarAutoFailedKeysRef）。
          if (sidebarAutoFailedKeysRef.current.has(key) === true) continue;
          // 用户刚刚在这个 key 上表达过手动意图：交给手动链路结算，Auto 本轮让位（手动恒优先）。
          if (sidebarManualIntentOf(key) !== undefined) continue;
          const used = attempts.get(key) ?? 0;
          if (used >= SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS) {
            // 有界重试用尽：只撤销来源标记，tab 留给用户（绝不无限重试，也绝不改用批量入口）。
            origin.delete(key);
            attempts.delete(key);
            continue;
          }
          attempts.set(key, used + 1);
          // attemptsBefore 让「动作在真正调用 close 之前被撤销」的路径能精确回退这一次尝试计数，
          // 否则一次被取消的自动关闭就会白烧掉一次有界重试预算。
          return { key, address: entry.address, kind: "close", attemptsBefore: used };
        }
        return null;
      };
      const autoOpenCandidate = (running) => {
        // 能力降级 fail-closed：close()/落地证据/左箭头任一缺失时绝不自动打开（见 sidebarAutoOpenCapable）。
        if (sidebarAutoOpenCapable() !== true) return null;
        const origin = sidebarAutoOriginRef.current;
        const suppressed = sidebarAutoSuppressedRef.current;
        const reservations = sidebarAutoReservationRef.current;
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
        for (const address of running) {
          const key = sidebarTabKey(sidebarSessionId, rootSessionId, address);
          // 本次级联里已经为它尝试过并失败：绝不在同一批微任务里重试（见 sidebarAutoFailedKeysRef）。
          if (sidebarAutoFailedKeysRef.current.has(key) === true) continue;
          // 用户手动关闭过：绝不立刻重开（抑制只由用户手动重新打开清除）。
          if (suppressed.has(key) === true) continue;
          // 本次运行已经为它成功发出过打开动作：绝不重复打开（与失败无关，失败会撤销预留）。
          if (origin.has(key) === true) continue;
          // 已经有一个候选为它预留：同一资源绝不并发两个动作。
          if (reservations.has(key) === true) continue;
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          // 用户在同一个 key 上有未结算的手动意图：让手动链路先结算，Auto 本轮跳过。
          if (sidebarManualIntentOf(key) !== undefined) continue;
          const record = records.get(key);
          if (record !== undefined && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId) continue;
          const opening = openings.get(key);
          if (opening !== undefined && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId) continue;
          /**
           * 存在性检查必须「先可读、再确认没有」：
           * - inventory 不可读时无法证明资源没打开，fail-closed 跳过这个候选（宁可不动，也不开出重复页）；
           * - inventory 可读但没有该地址、而 active() 已经是它（提交延迟 / 别的 pane）：同样视为已经存在
           *   的手动/未知来源，不重复打开，也不写 auto 来源。
           */
          const state = sidebarResourceTabStateOf(address);
          if (state.readable !== true) continue;
          if (state.tabId !== null) continue;
          if (sidebarActiveResourceMatches(address) === true) continue;
          /**
           * 先写**预留**再发动作：任何重入（observer/轮询/尾随同步）都不会为同一个资源再选一次。
           * 预留只是候选去重，绝不等于「Auto 已经打开」——只有 openResource 真的成功发出后才会
           * 升级成来源标记；失败路径在 handleSidebarAction 的 finally 里撤销它，使后续同步可以重试。
           */
          const epoch = sidebarAutoEpochRef.current;
          reservations.set(key, { sessionId: sidebarSessionId, rootSessionId, address, epoch });
          trimAutoKeyMap(reservations);
          return { key, address, kind: "open", epoch };
        }
        return null;
      };
      /** 上限淘汰：按插入顺序丢弃最旧的键（复合键跨 root 保留时的安全阀，见 SIDEBAR_AUTO_KEY_LIMIT）。 */
      const trimAutoKeyMap = (map) => {
        while (map.size > SIDEBAR_AUTO_KEY_LIMIT) {
          const oldest = map.keys().next();
          if (oldest.done === true) break;
          map.delete(oldest.value);
        }
      };
      /**
       * 清理已经离开当前快照的复合键（来源与抑制两个集合），避免长期泄漏。
       *
       * 只清理当前 surface 的键：别的 session/root 的资源不在这一份快照里，无法判定是否仍存在。
       * 本轮已经选中的候选键必须保留——它正要被关闭，删掉记账会让这次关闭失去来源身份。
       */
      const cleanupAutoSidebarKeys = (known, actingKey) => {
        for (const map of [sidebarAutoOriginRef.current, sidebarAutoSuppressedRef.current]) {
          for (const [key, entry] of map) {
            if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
            if (key === actingKey) continue;
            if (known.has(entry.address) === true) continue;
            map.delete(key);
            sidebarAutoCloseAttemptsRef.current.delete(key);
          }
        }
        // 预留同样要清理，但**在途动作自己那一条绝不能被清理**：它的 finally 才是唯一的释放点，
        // 提前删掉会让同一条动作在收尾时把后来者的预留一起删掉。
        for (const [key, entry] of sidebarAutoReservationRef.current) {
          if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
          if (key === actingKey) continue;
          if (known.has(entry.address) === true) continue;
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          sidebarAutoReservationRef.current.delete(key);
        }
      };
      /**
       * 放行一个自动动作。
       *
       * 复用用户点击的同一条入口（handleSidebarAction + origin=auto）：同一把 pending 锁、同一段
       * split 事务、同一套「用真实 tabId 关闭」的记录语义，因此自动路径不存在第二套打开/关闭实现。
       * 动作收尾后才重新推进同步，下一个候选（或清理）由那条链路继续。
       */
      const launchAutoSidebarAction = (candidate) => {
        sidebarAutoBusyRef.current = true;
        void Promise.resolve()
          // candidate 作为自动动作上下文（kind/epoch/预留）传入：动作必须在每个 await 之后
          // 复核它是否仍然有效，并在收尾时无条件释放预留（见 handleSidebarAction）。
          .then(() => handleSidebarAction(candidate.key, candidate.address, SIDEBAR_TAB_ORIGIN_AUTO, candidate))
          .catch(() => { /* 打开/关闭失败只影响这一次动作：状态由既有记录与重试记账负责。 */ })
          .then(() => {
            sidebarAutoBusyRef.current = false;
            /**
             * 尾随同步只用来推进「下一个候选」。它必须带着级联标记执行：这一轮里失败过的 key
             * 不会被重新选中，因此「失败 → 撤销预留 → 立刻重选」不在微任务里自转（见
             * sidebarAutoFailedKeysRef）。真正的重试留给下一个外部同步轮。
             */
            sidebarAutoCascadeRef.current = true;
            try {
              // 用引用取最新一轮渲染的同步器（与 observer/轮询同一写法），绝不复用当前闭包。
              sidebarTabSyncRef.current?.();
            } finally {
              sidebarAutoCascadeRef.current = false;
            }
          });
      };
      /**
       * 第二阶段：Auto（自动打开运行中的子代理侧栏）同步。
       *
       * 顺序固定为「先关后开」，并且只在有属于当前 root 的真实快照时动作：
       * 1. 关闭：Auto 亲手打开过的资源一旦不在运行中集合里，就用**已确认记录里的真实 tabId** 走
       *    既有 handleSidebarAction 关闭路径（绝不猜 tabId、绝不调用批量关闭）；
       * 2. 打开：运行中、尚未打开、且没有被用户手动关闭抑制的资源走既有打开路径；
       * 3. 清理：把已经离开当前快照的复合键从来源/抑制集合里移除。
       *
       * 开关关闭时不做任何自动 open/close（历史行为逐字节不变），已打开的 tab 交由用户手动处理；
       * 清理阶段与开关无关，它只维护插件自己的记账，不触碰宿主。
       */
      const syncAutoSidebarTabs = () => {
        const source = snapshot;
        // 没有快照（首次加载 / 读取失败）时没有「谁在运行」的证据：既不打开也不关闭。
        if (source === null || source === undefined) return;
        // root 切换瞬间旧快照可能仍在 state 里：只有属于当前 root 的快照才能决定动作。
        if (text(source.rootSessionId, null) !== rootSessionId) return;
        const known = knownSidebarResourceAddresses();
        const running = runningSidebarResourceAddresses();
        const enabled = autoOpenEnabled();
        let candidate = null;
        if (enabled === true && sidebarAutoBusyRef.current !== true) {
          candidate = autoCloseCandidate(running) ?? autoOpenCandidate(running);
        }
        cleanupAutoSidebarKeys(known, candidate === null ? null : candidate.key);
        if (candidate === null) return;
        launchAutoSidebarAction(candidate);
      };

      /**
       * 自动动作是否仍然有效：Auto 仍开启、动作代次未变、面板仍挂在同一个 root / sidebar session 上。
       *
       * 这是「关闭 Auto 取消在途打开」的判据：Auto getter 每次现读（权威读面），代次在开关变化时
       * 递增，surface 身份用与 handleSidebarAction 入口相同的三个 ref 复核。任一项不成立，那次自动
       * 动作一律放弃副作用。
       */
      const autoActionStillValid = (context) => {
        if (context === null || context === undefined) return false;
        if (autoOpenEnabled() !== true) return false;
        if (sidebarAutoEpochRef.current !== context.epoch) return false;
        return mountedRef.current === true
          && currentRootRef.current === rootSessionId
          && currentSidebarSessionRef.current === sidebarSessionId;
      };
      /**
       * 撤销一次自动动作的在途记账（Auto 关闭 / 代次过期 / 手动接管 / 失败路径共用）。
       *
       * 三件事缺一不可：
       * 1. 收口这次动作开出的 split 事务：否则右栏会停在事务的临时 50%，直到 15 秒 deadline 才回落；
       * 2. 删掉这个 key 的在途打开记录：这次打开没有发出，不能让后续同步把它当成「还没确认的打开」；
       * 3. 释放预留：失败绝不等于「已经打开过」，下一次同步必须能重新选中这个资源。
       * 来源标记只在 openResource 成功发出时才存在，因此这里不删除它（关闭类动作被撤销后，
       * 那个 tab 仍然属于 Auto，开关重新打开后仍可被自动回收）。
       */
      const abandonAutoSidebarAction = (key, context) => {
        if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("auto-abandoned");
        sidebarTabOpeningRef.current.delete(key);
        sidebarAutoReservationRef.current.delete(key);
        releaseAutoCloseAttempt(key, context);
      };
      /** 回退候选选择时预支的那一次自动关闭重试（动作在真正调用 close 之前被撤销时调用）。 */
      const releaseAutoCloseAttempt = (key, context) => {
        if (context === null || context === undefined || context.kind !== "close") return;
        const attempts = sidebarAutoCloseAttemptsRef.current;
        if (attempts.has(key) !== true) return;
        if (context.attemptsBefore === 0) attempts.delete(key);
        else attempts.set(key, context.attemptsBefore);
      };
      /**
       * 自动动作在副作用之前必须让位的「手动接管」状态：
       * - "close"：用户在同一个 key 上留下过关闭意图——Auto 绝不能在关闭意图之后再打开一个 tab；
       * - "open"：用户手动要求打开这个资源——打开照常发出，但最终 tab 必须记成 manual 来源；
       * - null：没有手动接管。
       */
      const autoTakeoverStateOf = (key) => {
        const intent = sidebarManualIntentOf(key);
        if (intent === undefined) return null;
        return intent.intent === "close" ? "close" : "open";
      };
      /**
       * 记录一次「在途动作期间」的用户手动意图。
       *
       * 触发点只有两个（用户点击落在一个已被 pending 锁或未落地打开占用的 key 上）：意图方向按
       * 点击那一刻的按钮语义判定——已经有记录（<<）表示要关闭，没有记录（>>）表示要打开，
       * 绝不按动作在途时的中间态猜方向。方向判定与 handleSidebarAction 的分支条件同源。
       */
      const recordSidebarManualIntent = (key, resourceAddress) => {
        const record = sidebarTabRecordsRef.current.get(key);
        const scoped = record !== undefined
          && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
        sidebarManualIntentRef.current.set(key, {
          sessionId: sidebarSessionId,
          rootSessionId,
          address: resourceAddress,
          intent: scoped ? "close" : "open",
        });
      };
      /**
       * 结算一个 key 上的手动意图（在途动作收尾后，以及同步的兜底扫描里调用）。
       *
       * 手动恒优先，但**只按当下的真实状态结算**，绝不盲目重放那次点击：
       * - 还有动作在途（pending）或打开尚未落地：这一轮什么都不做，等下一次收尾再结算；
       * - 「打开」：已经开着就把来源改回 manual（Auto 不再管它）；还没开出才补发一次**手动**打开，
       *   走与点击完全相同的入口（唯一区别是 origin=manual，因此后续绝不会被自动关闭）；
       * - 「关闭」：有精确 tabId 时走同一入口关闭并登记抑制；没有可关闭的 tab 时只登记抑制，
       *   绝不为了「执行这次关闭」而先打开一个 tab。
       */
      const applyPendingManualIntent = (key) => {
        const entry = sidebarManualIntentOf(key);
        if (entry === undefined) return;
        // 同一 key 仍有动作在途：它收尾时会再结算一次，绝不在这里并发派发第二个动作。
        if (sidebarTabPendingRef.current.has(key) === true) return;
        const opening = sidebarTabOpeningRef.current.get(key);
        const openingScoped = opening !== undefined
          && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId;
        const record = sidebarTabRecordsRef.current.get(key);
        const recordScoped = record !== undefined
          && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
        if (entry.intent === "open") {
          if (openingScoped) {
            // 这次打开仍在途：把它的来源改成 manual，落地后就是手动 tab（绝不并发第二次 openResource）。
            opening.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
            sidebarManualIntentRef.current.delete(key);
            return;
          }
          if (recordScoped) {
            // 用户手动打开 = 他重新要这个会话：清除抑制，并把来源收回 manual（Auto 不得再自动关它）。
            record.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
            sidebarAutoSuppressedRef.current.delete(key);
            sidebarAutoOriginRef.current.delete(key);
            sidebarAutoCloseAttemptsRef.current.delete(key);
            sidebarManualIntentRef.current.delete(key);
            return;
          }
          sidebarManualIntentRef.current.delete(key);
          void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
          return;
        }
        // intent === "close"
        if (recordScoped) {
          sidebarManualIntentRef.current.delete(key);
          void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
          return;
        }
        if (openingScoped) {
          /**
           * 打开仍在途、此刻没有可精确关闭的 tabId：抑制先登记（用户要的是关闭，Auto 不得重开），
           * 意图保留到它落地或超时——由同一条同步链路再结算一次，绝不在没有 tabId 时猜一个 id 去关。
           */
          sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
          trimAutoKeyMap(sidebarAutoSuppressedRef.current);
          return;
        }
        // 没有可关闭的 tab：只登记抑制与撤销自动记账，绝不为了「执行关闭」先打开一个 tab。
        sidebarManualIntentRef.current.delete(key);
        sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
        trimAutoKeyMap(sidebarAutoSuppressedRef.current);
        sidebarAutoOriginRef.current.delete(key);
        sidebarAutoCloseAttemptsRef.current.delete(key);
      };

      /**
       * 右栏 tab 的完整同步入口（挂载 effect / 2.5 秒轮询 / sessions 通知 / observer / 可见性变化
       * 全部只经由它）：先跑既有的记录/库存同步，再跑 Auto 自动同步。
       *
       * 顺序不可颠倒：自动打开必须建立在「库存与在途记录已经结算完」的基础上，否则同一个资源
       * 会被先记录再打开，重复消耗 pane。
       */
      const syncSidebarTabs = () => {
        /**
         * 外部同步轮（挂载 / 2.5 秒轮询 / observer / 可见性变化 / 会话通知）都是新的一轮：自动动作的
         * 失败屏障在这里失效，因此同一个资源仍然可以被重试。自动动作收尾的那条尾随同步例外——它
         * 只是同一批微任务里的推进，不构成「宿主状态可能已经改变」的新证据。
         */
        if (sidebarAutoCascadeRef.current !== true) sidebarAutoFailedKeysRef.current.clear();
        syncSidebarTabRecords();
        // Auto 开关是渲染输入：设置页保存或面板自身切换后必须重渲染一次（标题栏开关的勾选态）。
        // 与批量签名同一模式：只有真的变化才 bump，空闲轮询绝不产生重渲染。
        const autoNow = autoOpenEnabled();
        if (sidebarAutoSignatureRef.current !== autoNow) {
          sidebarAutoSignatureRef.current = autoNow;
          /**
           * 开关的权威值一变（含关闭）就推进自动动作代次：已经发出、仍在等待 split/layout 的在途
           * 自动动作会在下一次复核时放弃——「关闭 Auto」必须立刻取消还没落地的自动打开，而不是
           * 等它把 tab 打开之后再交给用户手动关。已存在的 tab 不受影响（关闭 Auto 绝不自动关 tab）。
           */
          sidebarAutoEpochRef.current += 1;
          // 权威值变化后丢弃本地乐观值，开关始终收敛到读出的事实。
          setAutoOpenDraft(null);
          bump((value) => value + 1);
        }
        syncAutoSidebarTabs();
      };
      // 挂载 effect 与轮询/observer 回调都只经由这个引用取最新闭包（见 sidebarTabSyncRef 的说明）。
      sidebarTabSyncRef.current = syncSidebarTabs;

      /**
       * 打开成功后按宿主 openTabs/active() 证据记录「可关闭的 tabId」。
       *
       * openTabs 条目或 active() 返回的 tab 满足下面三条才记录，缺一条都只说明「还没有可证明的落地证据」：
       * - 有效 id：没有 id 就无法在之后精确关闭，也就没有任何可关闭状态可言；
       * - `kind === "subagentchat"`：active 可能仍是用户原本在看的别的 tab；
       * - `contentId === 资源地址`：同一个 kind 下也可能是另一个子代理的地址。
       * 不满足时保持 >> 的打开语义（按钮照旧可再次点击打开），绝不猜测 tabId。
       *
       * origin 的来源优先级：显式传入的动作来源 > 在途打开记录里记下的来源 > 已存在记录的来源 >
       * **manual**。最后那条兜底正是规格要求：「外部已存在但未由自动动作发起的 tab 视为手动来源」，
       * 因此自动同步永远关不掉一个它没有亲手打开过的 tab。
       */
      const recordSidebarTab = (key, resourceAddress, actionOrigin) => {
        if (closeSidebarResource === null) return false;
         if (readActiveSidebarResource === null && readSidebarOpenTabs() === null) return false;
        // 左箭头图标缺失时不会渲染 <<，因此也不该建立只在 << 上才有意义的记录。
        if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return false;
        const declaredOrigin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO || actionOrigin === SIDEBAR_TAB_ORIGIN_MANUAL
          ? actionOrigin
          : null;
        let tab = null;
        const inventory = readSidebarOpenTabs();
        if (inventory !== null) {
          for (const entry of inventory) {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.contentId, null) !== resourceAddress) continue;
            const candidateId = text(candidate.tabId, null);
            if (candidateId !== null) {
              tab = { id: candidateId, kind: candidate.kind, contentId: candidate.contentId, title: null };
              break;
            }
          }
        }
        if (tab !== null && readActiveSidebarResource !== null) {
          try {
            const activeSource = object(readActiveSidebarResource.call(sidebarRight));
            if (text(activeSource.id, null) === tab.id) tab = { ...tab, title: text(activeSource.title, null) };
          } catch { /* inventory 已足够确认 tabId，标题读取失败不阻塞 toggle。 */ }
        }
        if (tab === null) {
          try { tab = readActiveSidebarResource.call(sidebarRight); } catch { return false; }
        }
        const source = object(tab);
        const tabId = text(source.id, null);
         const tabTitle = text(source.title, null);
        if (tabId === null) return false;
        if (text(source.kind, null) !== SUBAGENT_CHAT_KIND) return false;
        if (text(source.contentId, null) !== resourceAddress) return false;
        const previous = sidebarTabRecordsRef.current.get(key);
        const opening = sidebarTabOpeningRef.current.get(key);
        /**
         * 手动接管优先于调用方声明的来源：用户在那个 key 上留下过「要打开」的手动意图时，即使这次
         * 打开是 Auto 发出的，最终 tab 也必须记成 manual——手动打开的最终来源必须是 manual，
         * Auto 绝不能在资源结束后把它当成自己的 tab 关掉。
         */
        const manualTakeover = sidebarManualIntentOf(key);
        const origin = manualTakeover !== undefined && manualTakeover.intent === "open"
          ? SIDEBAR_TAB_ORIGIN_MANUAL
          : (declaredOrigin
            ?? (previous !== undefined && previous.sessionId === sidebarSessionId && previous.rootSessionId === rootSessionId
              ? previous.origin
              : null)
            ?? (opening !== undefined && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId
              ? opening.origin
              : null)
            ?? SIDEBAR_TAB_ORIGIN_MANUAL);
        const recordOrigin = origin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;
        if (previous !== undefined && previous.sessionId === sidebarSessionId
          && previous.rootSessionId === rootSessionId && previous.tabId === tabId) {
          previous.title = tabTitle ?? previous.title;
          previous.misses = 0;
          previous.origin = recordOrigin;
          return true;
        }
        sidebarTabRecordsRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, tabId, title: tabTitle, misses: 0, origin: recordOrigin });
         bump((value) => value + 1);
         return true;
      };

      /**
       * 侧栏箭头点击的唯一入口：打开与关闭共用一条路径，同一 key 上串行（pending 防重入）。
       *
       * 串行窗口覆盖从「读记录」到「记录落定」的整段同步逻辑：打开时 openResource 可能同步触发
       * 宿主的提交，重入点击若穿过检查就会发出第二次 openResource（第二个重复 tab）或提前走关闭。
       * 抛错处理：openResource / close 抛错只影响这一次动作，绝不写状态——打开失败保持 >>，
       * 关闭失败保持 <<（用户可以再点一次），两种情况都不会把按钮和真实世界对不上。
       *
       * origin 是**内部**参数，默认 manual：普通 UI 调用（箭头、键盘）一律手动来源；只有自动同步
       * 显式传 auto。它决定三件事：记录来源、手动动作是否清除抑制/自动来源、关闭时是否登记抑制。
       *
       * autoAction 也是**内部**参数，只在自动路径上出现：{ kind, epoch, attemptsBefore }。它让同一条
       * 实现能在每个 await 之后、真正调用宿主 open/close 之前复核「Auto 是否仍然开启、动作是否已过期、
       * 用户是否已经手动接管」，并在收尾时无条件释放在途预留（见 finally）。
       */
      const handleSidebarAction = async (key, resourceAddress, actionOrigin, autoAction) => {
        const origin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;
        const autoContext = origin === SIDEBAR_TAB_ORIGIN_AUTO && autoAction !== null && typeof autoAction === "object"
          ? {
            kind: autoAction.kind === "close" ? "close" : "open",
            epoch: Number.isFinite(Number(autoAction.epoch)) ? Number(autoAction.epoch) : sidebarAutoEpochRef.current,
            attemptsBefore: Number.isFinite(Number(autoAction.attemptsBefore)) ? Number(autoAction.attemptsBefore) : 0,
          }
          : null;
        // React 重挂载或 root 切换后，旧 DOM 可能短暂保留旧 handler；它不能操作当前 session-scoped 服务。
        if (mountedRef.current !== true
           || currentRootRef.current !== rootSessionId
           || currentSidebarSessionRef.current !== sidebarSessionId) {
          /**
           * 连入口都没通过的自动动作：这里必须自己释放候选选择时写下的预留（以及自动关闭的重试记账）。
           * 这些键属于已经被换掉的 surface，当前闭包之后再也不会为它们做清理。
           */
          if (autoContext !== null) {
            sidebarAutoReservationRef.current.delete(key);
            releaseAutoCloseAttempt(key, autoContext);
          }
          return;
        }
        const pending = sidebarTabPendingRef.current;
        if (pending.has(key)) {
          /**
           * 同一个 key 上已经有动作在途（典型：Auto 正在等 split 返回 pane / 等布局提交 / 等打开落地）。
           * 用户此刻的手动点击绝不能因为「锁被占用」而消失：它被记成手动意图，由在途动作在副作用之前
           * 让位、或由本函数收尾后立即结算（见 applyPendingManualIntent）。手动意图只在手动路径上记录。
           */
          if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
          return;
        }
        pending.add(key);
        /** 本次动作是否真的把 openResource 发给了宿主：只有它才允许建立 auto 来源标记。 */
        let openIssued = false;
        try {
          /**
           * 副作用之前的第一道复核（自动路径）：Auto 开关的权威值与动作代次都可能在等待期间变化。
           * 关闭 Auto 时必须在这里放弃——包括「已经 split 出 pane」的前一阶段遗留在途记录的情况。
           */
          if (autoContext !== null && autoActionStillValid(autoContext) !== true) {
            abandonAutoSidebarAction(key, autoContext);
            return;
          }
          const record = sidebarTabRecordsRef.current.get(key);
          if (record === undefined && sidebarTabOpeningRef.current.has(key)) {
            /**
             * 打开已经发出、落地证据还没到：手动点击同样不能丢。按意图记账，等它落地（或超时）后
             * 由同步链路结算；在这之前绝不补发第二次 openResource，也绝不猜 tabId 去关闭。
             */
            if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
            return;
          }
          // 关闭态：只调用记录里的精确 tabId。绝不根据 active() 当前是谁来决定关哪个 tab。
          if (record !== undefined && closeSidebarResource !== null) {
            let closed = false;
            try { closeSidebarResource.call(sidebarRight, record.tabId); closed = true; } catch { closed = false; }
            if (closed === true) {
              /**
               * 关闭成功后一起收口这个 key 上尚未结算的分栏事务。
               *
               * 现实窗口：目标 tab 已经进入公开 inventory（所以这里能拿到可关闭的 tabId），但宿主的
               * pane 组成证据还没提交（dockkit 尚未把它渲染进 split 返回的 pane）。此时只删记录会让
               * 右栏停在事务的临时 50%，直到 15 秒 deadline 才回落——用户看到的就是「收回后右栏卡在
               * 50% 十几秒」，同一行的下一次点击也只会撞上残留事务。取消事务既清掉在途事务，也让
               * 既有同步器按最新组成重估宽度（Expert Group-only ⇒ 立即回到 20%）。
               *
               * 只有同 key 的意图会被取消：别的行的在途打开照旧继续。
               */
              if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("close");
              sidebarTabRecordsRef.current.delete(key);
              sidebarAutoCloseAttemptsRef.current.delete(key);
              /**
               * 关闭成功后收口来源与抑制记账（两种开放的语义差别就在这两行）：
               *
               * - 自动关闭：只撤销来源标记——本次运行不会再对同一个资源重复动作；
               * - 手动关闭：除撤销来源外还要登记**抑制**，Auto 不得立刻把它重新打开。抑制只由
               *   用户手动重新打开同一资源清除（手动意图优先）。
               */
              sidebarAutoOriginRef.current.delete(key);
              if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
                sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
                trimAutoKeyMap(sidebarAutoSuppressedRef.current);
              }
              bump((value) => value + 1);
              // 关闭改变了右栏组成，必须立刻重估一次：宽度与手柄锁都在同一条同步链路上。
              syncSidebarTabs();
            }
            return;
          }
          if (openSidebarResource === null) return;
          /**
           * 自动动作的副作用复核点：真实的用户可见副作用（split / openResource）之前必须重新确认
           * 「Auto 仍开启」「动作代次没过期」「用户没有在同一个 key 上手动接管」。返回值：
           * - "proceed"：照常执行；
           * - "abort"：Auto 已关闭/动作已过期，或用户要求关闭 → 撤销在途记账，绝不发出副作用；
           * - "manual"：用户手动要求打开 → 动作可以继续，但最终 tab 必须记成 manual 来源。
           * 手动路径（autoContext === null）永远是 "proceed"，历史行为逐字不变。
           */
          const reviewAutoSideEffect = () => {
            if (autoContext === null) return "proceed";
            if (autoContext === null) return "proceed";
            if (autoActionStillValid(autoContext) !== true) return "abort";
            const takeover = autoTakeoverStateOf(key);
            if (takeover === "close") return "abort";
            if (takeover === "open") return "manual";
            return "proceed";
          };
          /** 本次打开最终要记的来源：自动动作只在没有手动接管时才是 auto。 */
          let effectiveOrigin = origin;
          const canTrackOpen = closeSidebarResource !== null
             && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
             && typeof primitives?.IconChevronLeftOutlineRegular === "function";
          const canObserveOpenCommit = canTrackOpen
            && globalThis.document !== null && globalThis.document !== undefined;
          if (canObserveOpenCommit) {
            sidebarTabOpeningRef.current.set(key, {
              sessionId: sidebarSessionId,
              rootSessionId,
              resourceAddress,
              expiresAt: Date.now() + SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,
              origin,
            });
          }
          /**
           * 手动打开的意图优先于自动记账：
           *
           * - 清除抑制：用户手动重新打开 = 他重新要这个会话，Auto 之后可以继续管理它；
           * - 撤销自动来源：这次打开是手动来源，Auto 绝不能在资源结束时把它当成自己的 tab 关掉。
           * 两条都在发动作之前写，因此这一段没有 await，不存在与自动同步交叉的窗口。
           */
          if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
            sidebarAutoSuppressedRef.current.delete(key);
            sidebarAutoOriginRef.current.delete(key);
            sidebarAutoCloseAttemptsRef.current.delete(key);
          }
          const targetPaneId = existingSubagentPaneId();
          let openOptions = null;
          let splitToken = null;
          if (targetPaneId !== null) {
            // 已经有独立子代理 pane：后续资源固定复用它，不再消耗新的 pane 配额。
            openOptions = { kind: SUBAGENT_CHAT_KIND, paneId: targetPaneId, preferNewPane: false };
          } else if (splitSidebarPane !== null) {
            // 新版公开 split() 是唯一能确认「确实创建了另一个 pane」的回执。
            // 返回 undefined 或调用抛错都表示宿主拒绝分栏；此时不打开资源，避免
            // openResource 静默回落到当前的 Expert Group pane。
            const tabsBeforeSplit = readSidebarOpenTabs();
            if (beginSidebarSplit !== null) {
              let preparation = null;
              try {
                preparation = beginSidebarSplit.call(config, {
                  sessionId: sidebarSessionId,
                  rootSessionId,
                  key,
                  resourceAddress,
                });
              } catch {
                preparation = null;
              }
              if (preparation?.busy === true) {
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              // install coordinator 已接管新版 split 时，null/缺 token 表示宽度或 surface
              // 准备失败；必须在调用 split() 之前中止，不能把 20% 状态下的 split 静默发给宿主。
              if (preparation === null || typeof preparation !== "object"
                || preparation.token === null || preparation.token === undefined) {
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              splitToken = preparation.token;
              if (splitToken !== null) {
                sidebarSplitIntentRef.current = {
                  token: splitToken,
                  key,
                  resourceAddress,
                  paneId: null,
                  resourceIssued: false,
                };
              }
              // 宽度 action 返回只代表 store 已写入；必须等宿主把新宽度提交到 DockLayout，
              // 否则 split() 仍会读到旧 room.row=false，并弹出「栏宽不足」。
              await waitForSidebarSplitLayoutCommit();
              const splitStillCurrent = mountedRef.current === true
                && currentRootRef.current === rootSessionId
                && currentSidebarSessionRef.current === sidebarSessionId
                && sidebarSplitIntentRef.current?.token === splitToken;
              if (!splitStillCurrent) {
                // session 切换、卸载或 deadline 已经收口时，不得让旧点击继续操作新 surface。
                if (sidebarSplitIntentRef.current?.token === splitToken) cancelPendingSidebarSplit("split-stale");
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              /**
               * 布局等待是这条路径上唯一会跨越用户操作窗口的 await：用户可能在这里关闭了 Auto，
               * 也可能在同一个 key 上手动接管。此时连 split() 都还没调用，直接放弃是代价最小的时机。
               */
              const afterLayoutReview = reviewAutoSideEffect();
              if (afterLayoutReview === "abort") {
                abandonAutoSidebarAction(key, autoContext);
                if (autoTakeoverStateOf(key) === "close") {
                  // 用户要的是关闭：立刻登记抑制，Auto 不得在下一轮同步里把它重新选成候选。
                  sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
                  trimAutoKeyMap(sidebarAutoSuppressedRef.current);
                }
                return;
              }
              if (afterLayoutReview === "manual") effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
            }
            let paneId = null;
            try { paneId = splitSidebarPane.call(sidebarRight); } catch { paneId = null; }
            if (typeof paneId !== "string" || paneId.trim() === "") {
              if (splitToken !== null) cancelPendingSidebarSplit("split-failed");
              sidebarTabOpeningRef.current.delete(key);
              return;
            }
            if (splitToken !== null) {
              let accepted = true;
              if (markSidebarSplitPane !== null) {
                try { accepted = markSidebarSplitPane.call(config, splitToken, paneId) !== false; } catch { accepted = false; }
              }
              if (!accepted) {
                cancelPendingSidebarSplit("pane-rejected");
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              if (sidebarSplitIntentRef.current?.token === splitToken) {
                sidebarSplitIntentRef.current.paneId = paneId;
              }
            }
            const guideTabId = seededGuideTabId(tabsBeforeSplit, sidebarSessionId);
            // split() 的默认 guide 也必须在同一次导航意图中被替换，否则新 pane 会出现
            // 一个多余的「开始」tab；replaceTab 仍是公开 openResource 选项。
            openOptions = { kind: SUBAGENT_CHAT_KIND, paneId, preferNewPane: false };
            if (guideTabId !== null) openOptions.replaceTab = guideTabId;
          } else {
            // 旧宿主没有公开 split()：保留历史 preferNewPane 请求，兼容旧版本。
            openOptions = { kind: SUBAGENT_CHAT_KIND, preferNewPane: true };
          }
          /**
           * 真正发出副作用之前的最后一道复核：从「读记录」到这里可能已经跨过 split 前的布局等待，
           * Auto 开关与用户手动意图都可能变化。只有通过复核才允许调用宿主 openResource()——绝不把
           * 一个已经关掉的 Auto 变成一次迟到的自动打开。
           */
          const beforeOpenReview = reviewAutoSideEffect();
          if (beforeOpenReview === "abort") {
            abandonAutoSidebarAction(key, autoContext);
            if (autoTakeoverStateOf(key) === "close") {
              // 用户要的是关闭：立刻登记抑制，绝不在同一轮或下一轮同步里把这个资源重新打开。
              sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
              trimAutoKeyMap(sidebarAutoSuppressedRef.current);
            }
            return;
          }
          if (beforeOpenReview === "manual") effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
          openSidebarResource.call(sidebarRight, resourceAddress, openOptions);
          openIssued = true;
          /**
           * 预留 → 来源的升级点：只有 openResource 真的成功发出、且宿主具备可追踪能力（能读到 tabId、
           * 能精确关闭）时，才把这次打开记成「Auto 亲手打开」。openResource 抛错时直接走 catch，
           * 来源标记绝不写；能力不足时也不写——将来无法精确回收的 tab 不归 Auto 管。
           */
          if (effectiveOrigin === SIDEBAR_TAB_ORIGIN_AUTO && canTrackOpen === true) {
            sidebarAutoOriginRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
            trimAutoKeyMap(sidebarAutoOriginRef.current);
          }
          if (splitToken !== null) {
            let acknowledged = true;
            if (markSidebarSplitOpen !== null) {
              try { acknowledged = markSidebarSplitOpen.call(config, splitToken) !== false; } catch { acknowledged = false; }
            }
            if (!acknowledged) {
              cancelPendingSidebarSplit("resource-not-acknowledged");
            } else if (sidebarSplitIntentRef.current?.token === splitToken) {
              sidebarSplitIntentRef.current.resourceIssued = true;
            }
          }
          // 记录必须发生在 openResource 之后：它读的是宿主提交后的 active tab，是打开的证据。
          const opened = recordSidebarTab(key, resourceAddress, effectiveOrigin);
          // 只要这次打开的 tab 已经落定，就不能留下 opening 记录：它的语义是「这次打开还没有确定
          // 证据」（split 事务仍在等待 pane 证据、或本来就没有事务时都一样）。残留的 opening 会让
          // 用户收回这个 tab 之后的下一次同步把关闭记录重新建回来（<< 复活），并把之后的点击挡成
          // 「点了没反应」——在途状态一律由上面的 split 意图与取消路径负责收口。
          if (opened) sidebarTabOpeningRef.current.delete(key);
          // openResource 可能已经同步提交 tab：立即推进一次同步，让同 pane 回退不依赖下一轮 observer。
          // 若宿主稍后才渲染 DOM，keepMounted + observer/轮询仍会继续补偿。
          syncSidebarTabs();
        } catch {
           if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("resource-failed");
           sidebarTabOpeningRef.current.delete(key);
           /* 宿主暂时打不开/关不掉这个地址：只影响这一次侧栏动作，状态绝不被污染。 */
         }
        finally {
          pending.delete(key);
          /**
           * 自动动作收尾时无条件释放在途记账（split busy、准备失败、layout 失效、open 抛错、
           * surface 变化、被撤销都走这里）：
           * - 预留必须释放，否则一次失败会被永久记成「已经打开过」，该资源在本次运行里再也打不开；
           * - 打开没有真正发出时，这个 key 不存在「Auto 亲手打开」的事实，残留来源标记一并撤销。
           */
          if (autoContext !== null) {
            sidebarAutoReservationRef.current.delete(key);
            if (autoContext.kind === "open" && openIssued !== true) {
              sidebarAutoOriginRef.current.delete(key);
              // 本次打开没有发出：把 key 记进失败屏障，同一批微任务里绝不再重选它（见其说明）。
              sidebarAutoFailedKeysRef.current.add(key);
            }
            if (openIssued === true) sidebarAutoFailedKeysRef.current.delete(key);
          }
          /**
           * 在途动作收尾后立刻结算用户在这个窗口里表达的手动意图：手动恒优先，绝不因为「那次点击撞上
           * 了 pending 锁」而丢失。没有意图时这一步是幂等空操作。
           */
          applyPendingManualIntent(key);
        }
      };

      /**
       * 批量关闭的唯一入口（主代理行 = 当前 root 的运行中专家/分片；空闲分组标题行 = ready 专家/已结算 fan-out 的空闲分片）。
       *
       * 与单会话箭头共用的三条并发与生命周期边界：
       * 1) 聚合锁覆盖整段 await 序列：双击/连击只允许第一次穿过，pending 期间按钮 disabled + aria-busy；
       *    锁按 (sidebar session, root) 组合键隔离，只拒绝**同一个 surface** 的重复点击——别的
       *    root/session 的批量按钮保持可用，绝不被一个与它无关的在途序列（甚至永不 settle 的
       *    宿主 Promise）阻塞；
       * 2) 候选集合在**点击那一刻**从同一个 inventory 快照固定下来（渲染期算好、随点击闭包传入），
       *    后续再点同一个按钮也不会把新出现的 tab 混进这一轮；
       * 3) 每次 await 前后都校验 mountedRef / currentRootRef / currentSidebarSessionRef：root 或
       *    sidebar session 切换、组件卸载后立即停止后续关闭，绝不让旧点击继续操作新 surface。
       *
       * 单项失败严格隔离：close 同步抛错或返回 rejected Promise 只跳过这一项并继续其余项，
       * 也绝不把失败项标成已关闭——关闭记录一律交给宿主 inventory 与既有同步器确认（这里不删记录）。
       */
      const handleSidebarBatchClose = async (candidates) => {
        if (mountedRef.current !== true
          || currentRootRef.current !== rootSessionId
          || currentSidebarSessionRef.current !== sidebarSessionId) return;
        if (closeSidebarResource === null) return;
        if (Array.isArray(candidates) !== true || candidates.length === 0) return;
        // 锁只覆盖「这一个 surface」：同一个 scope 的重复点击被拦下，别的 root/session 的批量按钮
        // 完全不受影响（它的键不在集合里）。
        const scopeKey = sidebarBatchScopeKey(sidebarSessionId, rootSessionId);
        const pendingScopes = sidebarBatchPendingRef.current;
        if (pendingScopes.has(scopeKey) === true) return;
        pendingScopes.add(scopeKey);
        // 立刻进入 pending 态：按钮 disabled + aria-busy，第二次点击在 has 检查处被拦下。
        bump((value) => value + 1);
        try {
          for (const tabId of candidates) {
            // await 之前：root/session 切换或卸载即停止后续关闭。
            if (mountedRef.current !== true
              || currentRootRef.current !== rootSessionId
              || currentSidebarSessionRef.current !== sidebarSessionId) return;
            try {
              // 单项 await：同步抛错与 rejected Promise 都在这里被隔离，序列继续。
              await closeSidebarResource.call(sidebarRight, tabId);
            } catch { /* 单项失败只影响这一项：失败项绝不被标成已关闭，也不改写任何记录。 */ }
            // await 之后：surface 已切换时不再继续（已经发出的那一次关闭照旧由宿主结算）。
            if (mountedRef.current !== true
              || currentRootRef.current !== rootSessionId
              || currentSidebarSessionRef.current !== sidebarSessionId) return;
          }
        } finally {
          // 只释放自己那一个 scope：旧序列的收尾绝不改写别的 root/session 的锁。
          pendingScopes.delete(scopeKey);
          // 重渲染与同步只服务**自己这一轮渲染**的 surface：root/session 已经切换时它们会去操作
          // 新 surface（旧 scope 的 bump 会让新 root 白白重渲染、旧闭包的 sync 会去同步旧 root）。
          // 回到同一个 root/session（键相同）时仍照常收尾，按钮不会因为缺少重渲染而停在 disabled。
          if (mountedRef.current === true
            && currentRootRef.current === rootSessionId
            && currentSidebarSessionRef.current === sidebarSessionId) {
            bump((value) => value + 1);
            // 关闭序列结束后推进一次同步：候选集合与签名都按宿主 inventory 重新读取，
            // 真正被宿主关掉的 tab 由既有同步器（present/active/浮窗标题证据）结算，插件不抢先删记录。
            syncSidebarTabs();
          }
        }
      };

      /**
       * 标题行批量控件（主代理行与空闲分组标题行共用）。
       *
       * 三态渲染：
       * - 候选 > 0 且 close 可用：与单会话箭头同款的双左尖括号按钮（30×20），
       *   aria-label/title 说明会关闭几个 tab，type=button，preventDefault + stopPropagation 必须同时存在；
       * - inventory 已知且候选为 0：非交互蓝色实心圆（12px）占位，没有 button / hover / tabindex；
       * - inventory 不可读，或候选 > 0 但 close 不可用：什么都不渲染（未知态绝不假报「零」，
       *   「关不掉」也绝不退化成「零」）。
       *
       * 这里**不看 openResource**：批量关闭只读取公开 inventory 并调用 close()，不需要打开任何资源。
       * 以打开能力当门槛会让「宿主能关不能开」（或注入面只给了 close）的右栏整行失去控件。
       * 唯一的渲染能力门槛是左尖括号图标：缺它时连零占位也不渲染。
       *
       * 绝不使用 aria-pressed：这是批量命令，不是 toggle 状态。
       */
      const renderSidebarBatchSlot = (addresses, label) => {
        const state = sidebarBatchStateFor(addresses);
        if (state.kind === "none") return null;
        if (state.kind === "zero") {
          // 左箭头图标缺失时连零占位也不渲染：没有可用的批量按钮能力就不该出现「本行有批量入口」的暗示。
          if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
          return react.createElement("div", { className: "deg_expert_group_trailing" },
            react.createElement("span", {
              className: "deg_expert_group_sidebar_batch_zero",
              "data-zero": "true",
              "aria-hidden": "true",
            }));
        }
        if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
        const count = state.candidates.length;
        const accessibleName = "在侧边栏关闭 " + count + " 个" + label;
        // 只看**当前** scope 的锁：别的 root/session 的在途序列绝不影响这一行的按钮状态。
        const pending = sidebarBatchPendingRef.current.has(sidebarBatchScopeKey(sidebarSessionId, rootSessionId));
        return react.createElement("div", { className: "deg_expert_group_trailing" },
          react.createElement("button", {
            type: "button",
            className: "deg_expert_group_sidebar_batch_action",
            title: accessibleName,
            "aria-label": accessibleName,
            "aria-busy": pending || undefined,
            disabled: pending,
            onClick: (event) => {
              event?.preventDefault?.();
              event?.stopPropagation?.();
              // 候选集合固定为这次渲染算出的那一份：点击后 inventory 再变也不影响本轮。
              return handleSidebarBatchClose(state.candidates);
            },
            onKeyDown: (event) => { event?.stopPropagation?.(); },
          }, react.createElement("span", {
            className: "deg_expert_group_double_arrow",
            "data-direction": "close",
            "aria-hidden": "true",
          },
          makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
          makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }))));
      };

      /**
       * 标题后「在右侧栏打开 / 关闭」箭头按钮：与 DSH 原生子代理行同款箭头图标。
       *
       * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名右箭头图标可用。
       * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
       *
       * 两种形态共用同一枚 20×20 按钮：
       * - `>>`（默认，橙色）：打开。可关闭能力齐备时额外带 aria-pressed=false / data-open=false；
       * - `<<`（打开态，青色）：关闭该行对应的那个 tab。只有「close + active + 左箭头图标」三件能力
       *   全部具备、且已经用 active() 证据记录过 tabId 时才出现；缺任何一件就退回静态 `>>`，
       *   绝不显示一个点了不会关的假 toggle 状态。
       *
       * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
       * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
       * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
       * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
       * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
       * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
       * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
       * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
       * 必须同时存在：鼠标事件不得冒泡到任务名/第三行的导航处理器，键盘 Enter/Space 在按钮上的
       * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
       * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
       */
      const renderSidebarOpenAction = (address, label) => {
        if (openSidebarResource === null) return null;
        const resourceAddress = subagentChatAddress(address);
        if (resourceAddress === null) return null;
        if (typeof primitives?.IconChevronRightOutlineRegular !== "function") return null;
        const toggleCapable = closeSidebarResource !== null
          && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
          && typeof primitives?.IconChevronLeftOutlineRegular === "function";
        // 键含 rootSessionId：两个子代理、两个 root 的状态互不影响。
        const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
        const openRecord = toggleCapable === true ? sidebarTabRecordsRef.current.get(key) : undefined;
        const isOpen = openRecord !== undefined;
        const accessibleName = (isOpen ? "在侧边栏关闭 " : "在侧边栏打开 ") + label;
        const buttonProps = {
          type: "button",
          className: "deg_expert_group_sidebar_action",
          title: accessibleName,
          "aria-label": accessibleName,
          onClick: (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return handleSidebarAction(key, resourceAddress);
          },
          onKeyDown: (event) => { event?.stopPropagation?.(); },
        };
        if (toggleCapable === true) {
          // aria-pressed 表达 toggle 语义；data-open 让主题样式精确命中打开态（青色 <<）。
          buttonProps["aria-pressed"] = isOpen;
          buttonProps["data-open"] = isOpen ? "true" : "false";
        }
        // 两个方向都是「两个同向图标」：打开是 >>，打开态是 <<。图标清单与 makeIcon 的具名图标
        // 契约一致，两条分支都已确认对应具名图标存在（右箭头在上面的渲染条件里，左箭头在能力判定里）。
        const arrowIcon = isOpen ? "IconChevronLeftOutlineRegular" : "IconChevronRightOutlineRegular";
        return react.createElement("button", buttonProps, react.createElement("span", {
          className: "deg_expert_group_double_arrow",
          "data-direction": isOpen ? "close" : "open",
          "aria-hidden": "true",
        },
        makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
        makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true })));
      };

      const renderChevron = (node, open) => react.createElement("button", {
        type: "button", className: "deg_expert_group_chevron", title: open ? "折叠" : "展开",
        "aria-label": open ? "折叠" : "展开", "aria-expanded": open, onClick: (event) => { event?.stopPropagation?.(); toggle(node); },
      }, makeIcon(primitives, open ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", { size: 14 }));

      /**
       * 每个代理节点固定三行；行内容与折叠状态无关，永不因展开状态隐藏任何一行。
       * 第一行：任务名（根节点是固定「主代理」，专家是最新 dispatch 短描述）；
       * 第二行：角色 · provider · model · effort 元数据；
       * 第三行：普通代理是 DSH 原生同源的 title · mode · activity；根节点只保留动态 title/activity。
       *
       * 第一行文案完整交给 CSS 处理，渲染层不做任何 grapheme 硬截断——完整文本同时是
       * React 文本、title（悬浮提示）与无障碍标签的来源，用户始终能读到全名。
       * 省略行为按行粒度区分（options.oneLine）：
       * - 默认 true：普通专家/根节点维持单行省略（.deg_expert_group_line 的
       *   overflow:hidden + text-overflow:ellipsis + white-space:nowrap），节点行高与树线语义不变；
       * - false：fan-out 分片第一行是「分片代号  任务名称」的组合文本，代号会占满单行额度，
       *   因此改用可换行样式（见 .deg_expert_group_shard_task），在右栏窄宽度下完整展示多行名称。
       *
       * 可导航的第一行与第三行是 role=button 的 div（不是嵌套 <button>，避免无效 HTML）：
       * 鼠标点击行为不变，同时支持键盘 Enter/Space，并带 tabIndex 与 aria-label。
       *
       * 标题后的侧栏箭头是**独立**的 <button>（任务标题行的内联位置，绝不包在可导航 div 里）：
       * 它只打开右侧栏的 subagentchat 页，不参与主视图导航，因此点击必须拦下冒泡。
       */
      const renderThreeLines = (node, options = {}) => {
        const source = object(node);
        const fullName = titleOf(source);
        const oneLine = options.oneLine !== false;
        const parentId = text(options.parentId, null);
        const clickableId = text(options.sessionId, text(source.sessionId, text(source.childId, null)));
        // 地址既决定主视图导航的目标形态（SubagentAddress 还是裸 session id），也决定侧栏
        // 箭头能否渲染；每行只解析一次，两条路径共用同一份结果。
        const address = subagentAddressOfChild(clickableId, parentId, source);
        // 工作区导航入口缺失（宿主未提供 uiWorkspace.openSession）时不渲染任何导航入口：
        // 行仍显示完整信息，但不再是 role=button，绝不留下点了没反应的按钮。
        const navigable = navigation.available === true && clickableId !== null;
        const onNavigate = navigable ? () => handleOpen(clickableId, address) : undefined;
        const onKeyDown = onNavigate === undefined ? undefined : (event) => {
          if (event?.key !== "Enter" && event?.key !== " ") return;
          // Space 默认会滚动页面，Enter 可能冒泡触发父级行为：两者都拦下。
          event.preventDefault?.();
          event.stopPropagation?.();
          onNavigate();
        };
        const taskLabel = "打开任务会话：" + fullName;
        const navigateProps = onNavigate === undefined ? {} : {
          role: "button",
          tabIndex: 0,
          "aria-label": taskLabel,
          onKeyDown,
        };
        const entry = catalogEntryOf(parentId, clickableId);
        const summary = agentSummaryOf(source, entry, authoritativeTitleOf(sessionsSnapshot, clickableId));
        const summaryProps = onNavigate === undefined ? {} : {
          role: "button",
          tabIndex: 0,
          "aria-label": "打开任务会话：" + (summary === "" ? fullName : summary),
          onKeyDown,
        };
        const metadata = metadataOf(source);
        const taskClassName = "deg_expert_group_line deg_expert_group_task"
          + (oneLine ? "" : " deg_expert_group_shard_task");
        const trailing = options.trailing === undefined ? null : options.trailing;
        const taskChildren = [
          react.createElement("div", { className: taskClassName, title: fullName, onClick: onNavigate, ...navigateProps }, fullName),
          renderSidebarOpenAction(address, fullName),
        ];
        if (trailing !== null) taskChildren.push(trailing);
        const taskLine = react.createElement("div", {
          className: "deg_expert_group_task_line" + (trailing === null ? "" : " deg_expert_group_task_line_trailing"),
        }, ...taskChildren);
        // 主代理批量控件作为标题行的相邻 flex 项，标题收缩省略时控件仍固定在标题末尾。
        // 其它专家 / 分片 / 空闲成员不传 trailing，单会话箭头结构保持不变。
        return react.createElement("div", { className: "deg_expert_group_row_main", "data-kind": source.kind || "expert", "data-expanded": true },
          taskLine,
          react.createElement("div", { className: "deg_expert_group_meta", title: metadata }, metadata),
          react.createElement("div", { className: "deg_expert_group_line deg_expert_group_content", title: summary, onClick: onNavigate, ...summaryProps }, summary));
      };

      /**
       * 代理节点的规范运行状态与官方目录证据。
       * 目录项来自会话投影 projectionsBySession[parentId].values.subagentCatalog（只保证
       * 身份/时间/模式/标签）；childId 由调用方给出（专家取 node.sessionId，分片取最新 attempt
       * 的 childId），缺失时只用快照证据。运行状态本身必须继续来自目录 activity 与 DEG 元数据，
       * 目录项缺失也绝不把 running 猜成 ready。
       */
      const runtimeStatusOfNode = (node, parentId, childId) => runtimeStatusOf(
        node,
        catalogEntryOf(parentId, childId ?? text(object(node).sessionId, null)),
      );

      const renderExpert = (node, index, parentId) => {
        const runtimeStatus = runtimeStatusOfNode(node, parentId);
        return react.createElement("div", { key: node.id || node.sessionId || "expert-" + index, className: "deg_expert_group_node" },
          react.createElement("div", { className: "deg_expert_group_row", "data-status": runtimeStatus, "data-expanded": true },
            statusIcon(react, primitives, runtimeStatus),
            react.createElement("span", { className: "deg_expert_group_chevron_placeholder", "aria-hidden": "true" }),
            react.createElement("div", null, renderThreeLines(node, { sessionId: node.sessionId, parentId }))),
          Array.isArray(node.children) && node.children.length > 0
            ? react.createElement("div", { className: "deg_expert_group_children" }, node.children.map((child, childIndex) => renderExpert(child, childIndex, parentId)))
            : null);
      };

      /**
       * 空闲分组是容器而非代理：它的圆点直接用规范值 ready（绿色静态圆点），
       * 分组内成员各自按官方目录证据决定 running/ready。
       */
      const renderIdleGroup = (nodes, trailing) => {
        // 空列表同样要渲染：snapshot 已经加载（调用方只在有快照时调用）时「空闲子代理（0）」与零圆点
        // 是用户看得到的零状态；加载中 / 没有快照时调用方根本不会走到这里，绝不伪造零。
        const members = Array.isArray(nodes) ? nodes : [];
        const group = { kind: "idle-group", id: rootSessionId + "__idle__", taskName: "空闲子代理", status: "idle", children: members };
        const open = expand(group);
        const idleTitleChildren = [
          react.createElement("div", { className: "deg_expert_group_line deg_expert_group_task" }, "空闲子代理（" + members.length + "）"),
        ];
        // 空闲分组的批量候选只来自当前 idleChildren；运行中的专家或分片会被排除。
        // slot 与计数标题同属第三列的 inline flex，标题按可用宽度省略，slot 不会被推到行尾。
        if (trailing !== undefined && trailing !== null) idleTitleChildren.push(trailing);
        return react.createElement("div", { className: "deg_expert_group_idle_group", "data-expanded": open },
          react.createElement("div", { className: "deg_expert_group_row deg_expert_group_idle_header", "data-status": "ready", "data-expanded": open },
            statusIcon(react, primitives, "ready"),
            renderChevron(group, open),
            react.createElement("div", { className: "deg_expert_group_idle_title_line" }, ...idleTitleChildren)),
          open ? react.createElement("div", { className: "deg_expert_group_children deg_expert_group_idle_children" }, members.map((node, index) => node.kind === "fanout" ? renderFanout(node, index) : renderExpert(node, index, rootSessionId))) : null);
      };

      const pendingSet = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 任务管理动作（取消分片 / 重试分片 / 取消父任务）的唯一入口。三条并发边界：
       *
       * 1) 去重锁覆盖「确认弹窗 await + RPC 发送 + 尾随刷新」全程：占位发生在**发起确认之前**，
       *    因此确认弹窗还开着时的重复点击（双击、连击、键盘重复触发）会在 has(key) 处静默返回，
       *    既不会弹出第二个确认，也不会并发发出第二个 RPC。旧实现先确认后占锁，await 期间锁是空的，
       *    重复点击会穿过检查并各发一次请求。
       * 2) 确认返回后重读**当前**选中的根会话（currentRootRef 每次渲染同步更新）再发请求：
       *    确认期间用户切换了 root 时，动作绑定切走后的新会话，绝不用闭包里捕获的旧值。
       * 3) 确认期间或 RPC 在途期间组件被卸载（宿主切换 surface 的常见形态）时静默放弃：
       *    不发请求、不刷新、不写状态，杜绝迟到 setState 与卸载后重新拉起的轮询请求。
       *
       * 锁键沿用「动作类型 + parentTaskId + shardId」而不含 rootSessionId：同一实例切换 root 后，
       * 新树里同 id 的按钮在这段收尾窗口内也会显示处理中，直到动作结算（最长一次 RPC 时长）。
       * 这是刻意取舍——锁只需要在「同一实例的同一个动作」上成立，加入 root 会让锁出现第二事实源，
       * 反而可能在切换瞬间漏锁；跨实例的重复提交由 Host 侧的任务状态判定兜底。
       */
      const runAction = async (request, key, requiresConfirm, message) => {
        // 已卸载的实例不再接受新动作（按钮即使还残留在旧 DOM 上也不会发出请求）。
        if (mountedRef.current !== true) return;
        // 同键动作进行中：静默忽略，不排队也不提示。
        if (pendingSet.current.has(key)) return;
        // 先占锁再确认：锁必须在第一个 await 之前生效，否则重复点击会穿过上面的空闲检查。
        pendingSet.current.add(key);
        // 立刻让同键动作进入 pending 态（按钮 disabled + aria-busy），单击到确认弹窗之间的
        // 空隙里再次点击同样会被 has(key) 拦下。
        bump((value) => value + 1);
        try {
          if (requiresConfirm) {
            // 没有确认能力时什么都不做：破坏性操作绝不降级为静默执行。
            if (typeof config.confirm !== "function") return;
            let accepted = false;
            try { accepted = await config.confirm(message); } catch { accepted = false; }
            if (accepted !== true) return;
            // 确认弹窗打开期间 surface 可能已被卸载：卸载即静默放弃，不再发请求。
            if (mountedRef.current !== true) return;
          }
          // 重读当前选中 root：ref 在每次渲染同步写入，因此这里拿到的是「确认完成这一刻」
          // 用户实际选中的会话。空会话无法定位任务，直接放弃而不是发一条无目标的请求。
          const targetSessionId = typeof currentRootRef.current === "string" ? currentRootRef.current : "";
          if (targetSessionId === "") return;
          await callRpc(config, contextRef.current, { ...request, sessionId: targetSessionId });
          // RPC 在途期间卸载：不刷新、不写状态（动作本身已由 Host 侧收下，无需再补）。
          if (mountedRef.current !== true) return;
          // 走最新渲染的 refresh：确认期间切换过 root 时，用旧闭包刷新会把旧 root 的快照
          // 写回新 surface，也会为旧 root 多发一次请求。
          await refreshRef.current();
        } catch (error) {
          // 卸载后的失败没有可展示的错误面，静默丢弃，绝不 setState。
          if (mountedRef.current !== true) return;
          // 操作失败与快照失败共用标题错误面：旧快照继续可见，用户可直接重试。
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        } finally {
          // 释放锁无条件执行（含提前 return 的分支）；只有仍挂载时才触发重渲染。
          pendingSet.current.delete(key);
          if (mountedRef.current === true) bump((value) => value + 1);
        }
      };

      const renderAction = (label, Icon, onClick, pending) => react.createElement("button", {
        type: "button", className: "deg_expert_group_action", title: pending ? label + "（处理中）" : label,
        "aria-label": pending ? label + "（处理中）" : label, "aria-busy": pending || undefined, disabled: pending, onClick,
      }, makeIcon(primitives, Icon, { size: 14 }));

      const renderShard = (task, shard, index) => {
        const shardKey = text(shard.shardId, "shard-" + index);
        const latestChildId = text(shard.childId, null);
        const status = statusOf(shard);
        // shardId 只在 parentTaskId 内唯一；折叠存储必须使用复合 id，避免不同 fan-out
        // 中同名 shard 互相覆盖。最新 attempt childId 仍是唯一导航目标。
        // 第一行文本：有任务名称时是"分片代号  任务名称"，没有名称的旧数据只有分片代号。
        // 拼接结果作为完整文本进入 renderThreeLines，并以 oneLine:false 走分片专用的可换行
        // 第一行样式：渲染层不再做 grapheme 截断，分片代号因此不会挤掉任务名称的显示额度。
        // shardId 仍是 key、data-shard-id 与取消/重试请求的唯一标识，
        // 展示文本绝不参与任何管理动作定位。名字为空白时按缺失处理，不显示悬空分隔符。
        const shardTaskName = text(shard.taskName, null);
        const shardNode = {
          ...shard,
          id: task.parentTaskId + ":" + shardKey,
          kind: "expert",
          taskName: shardTaskName === null || shardTaskName === shardKey ? shardKey : shardKey + "  " + shardTaskName,
          content: text(shard.prompt, ""),
        };
        const cancelKey = "cancel:" + task.parentTaskId + ":" + shardKey;
        const retryKey = "retry:" + task.parentTaskId + ":" + shardKey;
        const actions = [];
        if (ACTIVE_STATUSES.has(status)) actions.push(renderAction("取消分片 " + shardKey, "IconStopFillRegular", () => runAction({ action: "fanout-cancel-shard", parentTaskId: task.parentTaskId, shardId: shardKey }, cancelKey, true, "确认取消分片 " + shardKey + "？"), pendingSet.current.has(cancelKey)));
        if (RETRY_STATUSES.has(status)) actions.push(renderAction("重试分片 " + shardKey, "IconRefreshOutlineRegular", () => runAction({ action: "fanout-retry-shard", parentTaskId: task.parentTaskId, shardId: shardKey }, retryKey, false, ""), pendingSet.current.has(retryKey)));
        // 展示状态用规范运行状态，证据与第三行同源（最新 attempt 的 childId 查目录项）；
        // status 仍保留给取消/重试判定（管理语义不变）。
        const runtimeStatus = runtimeStatusOfNode(shardNode, rootSessionId, latestChildId);
        return react.createElement("div", { key: shardKey, className: "deg_expert_group_shard", "data-shard-id": shardKey, "data-status": runtimeStatus, "data-expanded": true },
          statusIcon(react, primitives, runtimeStatus),
          react.createElement("span", { className: "deg_expert_group_chevron_placeholder", "aria-hidden": "true" }),
          renderThreeLines(shardNode, { sessionId: latestChildId, parentId: rootSessionId, oneLine: false }),
          react.createElement("div", { className: "deg_expert_group_actions" }, actions));
      };

      const renderFanout = (task, index) => {
        const shards = Array.isArray(task.shards) ? task.shards : [];
        const open = expand(task);
        const incomplete = shards.filter((shard) => ACTIVE_STATUSES.has(statusOf(shard))).length;
        const parentKey = "cancel-parent:" + task.parentTaskId;
        const actions = ACTIVE_STATUSES.has(statusOf(task)) || incomplete > 0
          ? [renderAction("取消父任务（未完成 " + incomplete + " 个分片）", "IconStopFillRegular", () => runAction({ action: "fanout-cancel-parent", parentTaskId: task.parentTaskId }, parentKey, true, "确认取消父任务？未完成 " + incomplete + " 个分片。"), pendingSet.current.has(parentKey))]
          : [];
        // data-status 是对外的规范运行状态；管理状态改由 data-task-status 暴露，
        // 供了解 fan-out 内部结算的消费方读取，展示层不再出现 succeeded/failed 等词。
        const runtimeStatus = runtimeStatusOf(task, null);
        return react.createElement("div", { key: task.parentTaskId || "fanout-" + index, className: "deg_expert_group_fanout", "data-status": runtimeStatus, "data-task-status": statusOf(task) },
          react.createElement("div", { className: "deg_expert_group_fanout_header" },
            statusIcon(react, primitives, runtimeStatus),
            renderChevron(task, open),
            react.createElement("div", { className: "deg_expert_group_line deg_expert_group_task", title: titleOf(task), onClick: navigation.available === true && task.sessionId ? () => handleOpen(task.sessionId) : undefined }, titleOf(task)),
            react.createElement("div", { className: "deg_expert_group_actions" }, actions)),
          // 箭头函数按 (shard, index, array) 收到与旧 `renderShard.bind(null, task)` 完全相同的实参
          // （renderShard 只用前两个），但不再每次渲染都新建一个绑定函数。
          open ? react.createElement("div", { className: "deg_expert_group_fanout_shards deg_expert_group_tree_children" }, shards.map((shard, shardIndex) => renderShard(task, shard, shardIndex))) : null);
      };

      const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
      // 普通专家按实际运行状态分组，fan-out 父任务则按 manager 的聚合终态进入空闲组。
      // fan-out 展示与取消/重试仍使用各自的 manager 状态，不受分组位置影响。
      const idleChildren = sidebarIdleChildren();
      const visibleChildren = children.filter((node) => !idleChildren.includes(node));
      // 两行标题后的批量 slot 内容：主代理行只覆盖运行中的普通专家/最新分片，空闲标题行只覆盖
      // idleChildren。两者都只在渲染期纯读 openTabs inventory 与 close 能力（inventory 读不出来、
      // 或候选存在但 close 缺失时返回 null，不渲染任何东西）；打开能力不参与这里的判定。
      const rootBatchSlot = renderSidebarBatchSlot(runningSidebarResourceAddresses(), "运行中的子代理");
      const idleBatchSlot = renderSidebarBatchSlot(idleSidebarResourceAddresses(idleChildren), "空闲子代理");
      const root = snapshot?.root;
      const rootOpen = root === null ? true : expand(root);
      const body = viewState.loading && snapshot === null
        ? react.createElement("div", { className: "deg_expert_group_tree", "aria-busy": "true" }, react.createElement("div", { className: "deg_expert_group_skeleton" }), react.createElement("div", { className: "deg_expert_group_skeleton" }))
        : snapshot === null
          ? react.createElement("div", { className: "deg_expert_group_empty" }, "暂无 Expert Group 任务")
          : react.createElement("div", { className: "deg_expert_group_tree" },
            react.createElement("div", { className: "deg_expert_group_node deg_expert_group_node_root", "data-root": "true" },
              react.createElement("div", { className: "deg_expert_group_row", "data-status": runtimeStatusOf(root, null), "data-expanded": true }, statusIcon(react, primitives, runtimeStatusOf(root, null)), renderChevron(root, rootOpen), react.createElement("div", null, renderThreeLines(root, { sessionId: root.sessionId, parentId: null, expanded: true, trailing: rootBatchSlot }))),
              rootOpen ? react.createElement("div", { className: "deg_expert_group_children" }, [
                ...visibleChildren.map((node, index) => node.kind === "fanout" ? renderFanout(node, index) : renderExpert(node, index, rootSessionId)),
                renderIdleGroup(idleChildren, idleBatchSlot),
              ]) : null));
      /**
       * 标题栏「Auto」开关（紧凑、与标题同一行，不遮挡标题与行内批量控件）：
       *
       * - 勾选态：权威读面（install 注入的 getter，每次渲染现读）叠加本地乐观值；
       * - 可访问性：input 自带 aria-label="Auto"，可见文字也是 Auto，说明性文案只放在 title 里，
       *   不新增任何长段落；
       * - 写面缺失（直接 createExpertGroupPanel 的旧宿主/单测）时 disabled：绝不渲染一个点了没反应的开关。
       */
      const autoOpenChecked = autoOpenDraft === null ? autoOpenEnabled() : autoOpenDraft === true;
      const autoOpenToggle = react.createElement("label", {
        className: "deg_expert_group_header_auto",
        title: "自动打开运行中的子代理侧栏会话",
      },
      react.createElement("input", {
        type: "checkbox",
        className: "deg_expert_group_header_auto_input",
        "aria-label": "Auto",
        checked: autoOpenChecked,
        disabled: writeAutoOpenSetting === null,
        onChange: (event) => toggleAutoOpen(event?.target?.checked === true),
      }),
      react.createElement("span", { className: "deg_expert_group_header_auto_label" }, "Auto"));
      return react.createElement("section", { className: "deg_expert_group", "data-version": version, "aria-label": "Expert Group" },
        react.createElement("header", { className: "deg_expert_group_header" },
          react.createElement("span", { className: "deg_expert_group_header_title" }, "Expert Group"),
          autoOpenToggle,
          viewState.error !== null ? react.createElement("span", { className: "deg_expert_group_error", title: viewState.error }, "快照读取失败") : null,
          viewState.error !== null ? react.createElement("button", { type: "button", className: "deg_expert_group_header_action", title: "重试", "aria-label": "重试", onClick: retry }, makeIcon(primitives, "IconRefreshOutlineRegular", { size: 14 })) : null), body);
    }
    Panel.displayName = "ExpertGroupPanel";
    return Panel;
  }


  /**
   * 原生右栏「视觉连续性遮罩」（仅 DEG 侧补偿，**不是动画抑制**）。
   *
   * 真实诊断闭环：root→child 时 DSH 原生 RightbarSeat 的 surface 按 session key 重挂载——current
   * 变化后旧 [data-sidebar-right-panel] 先被移除，新 panel 稍后才挂上（仍是 collapsed），直到 DEG
   * openSurfaceTab 之后新 panel 才拿到 data-sidebar-right-open。这段「旧已删、新未开」的 DOM 空窗里
   * 右栏整块消失；transition/transform/visibility 抑制只能作用于存在的节点，覆盖不到它。
   *
   * 因此在 openSurfaceTab 之前把旧 panel 的**非交互视觉壳**克隆一份钉在旧位置：
   * - 只复制上一帧的视觉结构：clone 子树所有 id 移除（避免 DOM id 重复）、输入控件清空
   *   value/textContent（绝不携带、也绝不读取用户数据）；
   * - host 固定定位、pointer-events:none、aria-hidden=true、overflow:hidden、z-index 高于 panel：
   *   不拦截交互、不进入可访问性树、不影响布局；
   * - 新 panel 真正 open（不同节点 + data-sidebar-right-open + aria-hidden 非 true）或 500ms 兜底
   *   到点即移除；每次只允许一个遮罩，新一次 capture 先释放旧的；
   * - 绝不调用 layout/openRightbar、不触发 session 导航、不改动旧/新 panel 的 style；
   * - 任何 DOM API 缺失或异常都安全降级为「不创建遮罩」，绝不影响打开流程。
   */
  const RIGHTBAR_CONTINUITY_OVERLAY_ID = "dsh-expert-group-rightbar-continuity-overlay";
  /** 兜底释放时间（毫秒）：新 panel 迟迟不 open 时绝不长期遮盖 UI。 */
  const RIGHTBAR_CONTINUITY_FALLBACK_MS = 500;
  function createNativeRightbarContinuityOverlay() {
    let host = null;
    let observer = null;
    let timer = null;
    let originalPanel = null;

    const removeHost = (element) => {
      if (element === null || element === undefined) return;
      try {
        if (typeof element.remove === "function") element.remove();
        else element.parentNode?.removeChild?.(element);
      } catch { /* 移除失败也不能留下引用 */ }
    };
    /** 幂等释放：清 timer、断开 observer、移除宿主。 */
    const release = () => {
      if (timer !== null) {
        try { globalThis.clearTimeout?.(timer); } catch { /* 可选 API */ }
        timer = null;
      }
      if (observer !== null) {
        try { observer.disconnect?.(); } catch { /* 可选 API */ }
        observer = null;
      }
      const current = host;
      host = null;
      originalPanel = null;
      removeHost(current);
      return true;
    };
    /** 是否已经出现「不同于旧节点、并且真的 open」的原生 panel。 */
    const hasOpenedPanel = () => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelectorAll !== "function") return false;
      let panels = [];
      try { panels = Array.from(doc.querySelectorAll("[data-sidebar-right-panel]") ?? []); } catch { return false; }
      for (const candidate of panels) {
        if (candidate === null || candidate === undefined || candidate === originalPanel) continue;
        if (isOwnOverlayNode(candidate) === true) continue; // 遮罩内部的克隆不算新 panel
        try {
          if (typeof candidate.hasAttribute !== "function" || candidate.hasAttribute("data-sidebar-right-open") !== true) continue;
          if (typeof candidate.getAttribute === "function" && candidate.getAttribute("aria-hidden") === "true") continue;
          return true;
        } catch { /* 单个候选读取失败继续看其它 */ }
      }
      return false;
    };
    /** 遮罩宿主自身或其中的节点（遮罩绝不能把自己算成「新 panel」，也不能被别的探测命中）。 */
    const isOwnOverlayNode = (node) => {
      if (host === null || node === null || node === undefined) return false;
      try {
        let current = node;
        for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
          if (current === host) return true;
          current = current.parentNode ?? null;
        }
      } catch { return false; }
      return false;
    };
    /**
     * 只清理非交互视觉壳：移除 id（避免 DOM id 重复）、把克隆降级为纯视觉节点
     * （去掉 data-sidebar-right-panel，否则遮罩自己的克隆会被当成「新 panel」而瞬间自我释放，
     * 也可能被右栏探测当成真实面板）、清空输入控件；不读取任何值。
     * data-sidebar-right-open 必须保留：原生 CSS 用它决定 panel 是展开还是 collapsed，
     * 去掉后克隆会渲染成滑出屏幕的 collapsed 状态，遮罩就失去意义了。
     */
    const scrubClone = (node, depth = 0) => {
      if (node === null || node === undefined || depth > 12) return;
      try { node.removeAttribute?.("id"); } catch { /* 单个节点失败继续 */ }
      try { node.removeAttribute?.("data-sidebar-right-panel"); } catch { /* 同上 */ }
      try {
        const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          node.value = "";
          node.textContent = "";
        }
      } catch { /* 同上 */ }
      let children = [];
      try { children = Array.from(node.childNodes ?? node.children ?? []); } catch { children = []; }
      for (const child of children) scrubClone(child, depth + 1);
    };
    const observeBody = () => {
      const doc = globalThis.document;
      const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
      const body = doc?.body ?? null;
      if (typeof Observer !== "function" || body === null || typeof body !== "object") return;
      try {
        observer = new Observer(() => { if (hasOpenedPanel() === true) release(); });
        observer.observe(body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-sidebar-right-open", "aria-hidden"],
        });
      } catch {
        try { observer?.disconnect?.(); } catch { /* 忽略 */ }
        observer = null;
      }
    };
    const startFallback = () => {
      try {
        timer = globalThis.setTimeout(() => { timer = null; release(); }, RIGHTBAR_CONTINUITY_FALLBACK_MS);
      } catch { timer = null; /* 没有可用调度器：最坏情况由调用方 release */ }
    };
    /** 抢拍旧 panel 的视觉壳；返回幂等 release（供访问终止路径收口）。没有可复制目标时返回 null。 */
    const capture = () => {
      release(); // 每次只允许一个遮罩
      const doc = globalThis.document;
      if (!doc || typeof doc.createElement !== "function" || doc.body === null || doc.body === undefined) return null;
      let panel = null;
      try { panel = typeof doc.querySelector === "function" ? doc.querySelector("[data-sidebar-right-panel]") : null; } catch { panel = null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try { rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null; } catch { rect = null; }
      if (rect === null || typeof rect !== "object") return null;
      const left = Number(rect.left);
      const top = Number(rect.top);
      const width = Number(rect.width);
      const height = Number(rect.height);
      // 定位拿不到有效数字时不创建：宁可没有遮罩，也不能把 fixed 层丢到左上角盖住 UI。
      if ([left, top, width, height].every((value) => Number.isFinite(value)) !== true) return null;
      let clone = null;
      try { clone = typeof panel.cloneNode === "function" ? panel.cloneNode(true) : null; } catch { clone = null; }
      if (clone === null || clone === undefined) return null;
      let created = null;
      try {
        scrubClone(clone);
        try {
          if (clone.style !== undefined && clone.style !== null) clone.style.pointerEvents = "none";
        } catch { /* host 本身已经 pointer-events:none */ }
        removeHost(typeof doc.getElementById === "function" ? doc.getElementById(RIGHTBAR_CONTINUITY_OVERLAY_ID) : null);
        created = doc.createElement("div");
        created.id = RIGHTBAR_CONTINUITY_OVERLAY_ID;
        created.setAttribute("aria-hidden", "true");
        created.setAttribute("style",
          "position:fixed;z-index:2147482999;pointer-events:none;overflow:hidden;background:inherit;"
          + "left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;");
        created.appendChild(clone);
        doc.body.appendChild(created);
      } catch {
        removeHost(created);
        return null;
      }
      host = created;
      originalPanel = panel;
      // 新 panel 可能已经在这次同步提交里 open（例如 openTab 已提交）→ 立刻检查一次。
      if (hasOpenedPanel() === true) {
        release();
        return release;
      }
      observeBody();
      startFallback();
      return release;
    };
    return Object.freeze({ capture, release });
  }

  function installExpertGroupSidebar(ctx, deps) {
    const config = { ...object(deps), ctx };
    /**
     * 「任务管理」关闭时 Expert Group 不注册任何侧边栏入口。
     *
     * 返回幂等 no-op disposer（可重复调用且不释放任何别人的所有权），调用方因此可以沿用
     * 同一份 install/dispose 契约：关闭时直接释放既有 install 的 disposer，重新开启时重新
     * install 一次。这里只表示「本插件不注册」，不触碰 DSH 或 dsh-better-sidebar 的
     * tabsEnabled 偏好，也不回退到另一种注册方式。
     */
    if (config.taskManagementEnabled === false) return () => {};
    /**
     * 右栏拖拽手柄锁（Expert Group 页专属）：只在当前活动 tab 就是 Expert Group 时生效，
     * 切换页面、切换会话或卸载都会按同一条证据链恢复。状态与 DOM 写入都在这里，面板只通过
     * config.syncRightbarDragLock 请求一次重估（见下面 rightbarDragSyncImpl 的说明）。
     */
    const rightbarDragLock = createRightbarDragLock();
    /**
     * 首次分栏后的列宽配比（右栏内部的 40% / 60%，即视口的 20% / 30%）。
     *
     * 它与手柄锁是**两件事**、但共用同一条同步链路：手柄锁决定用户能不能拖总宽度，这里决定
     * split 容器里两条列轨各占多少。触发与恢复条件见 createSplitTrackRatio 的说明。
     */
    const splitTrackRatio = createSplitTrackRatio();
    /**
     * 列宽配比重估的读面（在 install 收尾时接线，见下面 splitTrackReader 赋值处的说明）。
     *
     * 读面必须以参数形式交给 splitTrackRatio：install 函数体里的 readSurfaceOpenTabs /
     * currentSurfaceSessionId 都是后置 const，而 openTargets() 会在函数体里就触发同步——
     * 直接在 splitTrackRatio 内部引用它们会撞上 TDZ（typeof 为 undefined），异常又被同步入口的
     * try/catch 吞掉，配比就永远写不进去。改成显式读面回调后，这条依赖是**编译器可见**的：
     * 调用点必须自己保证读面就绪。
     */
    let splitTrackReader = null;
    /** 请求一次列宽配比重估；读面还没接线时安全跳过（绝不猜组成、也不碰样式）。 */
    const requestSplitTrackSync = () => {
      // splitTrackReader 在 install 收尾前可能还未接线；disposed 优先阻断已排队的迟到回调。
      // 顺序不能反过来，否则早期注册期会在 disposed 的 TDZ 上求值。
      if (splitTrackReader === null || disposed) return false;
      return splitTrackRatio.sync(splitTrackReader.readTarget);
    };
    /**
     * 重估入口的真实实现：必须等 currentSurfaceSessionId / activeTabEvidenceOf（本闭包末尾才定义）
     * 就绪后才能求值，因此用一个可空引用转交——注册期（install 中段）与渲染期调用都不会踩到 TDZ。
     */
    let rightbarDragSyncImpl = null;
    /**
     * 请求一次「右栏拖拽手柄锁」重估。面板（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）与
     * openTargets（sessions 与 Better 状态通知）都经这里；dispose 后一律不再碰宿主 DOM。
     */
    const requestRightbarDragSync = () => {
      // 实现体在 install 函数体中段才赋值（它依赖同样后置的 currentSurfaceSessionId / 活跃 tab 读面），
      // 因此这里必须按引用转发，不能内联——注册期与渲染期调用都不会踩到 TDZ。
      // 引用为空时短路，既避开早期 disposed 的 TDZ，也阻断 dispose 后已经排队的迟到通知。
      if (rightbarDragSyncImpl === null || disposed) return;
      try { rightbarDragSyncImpl(); } catch { /* 手柄锁只是体验优化，绝不影响面板渲染。 */ }
    };
    /**
     * 面板卸载时的**无条件解锁**（离开 Expert Group 页这条边沿）。
     *
     * 为什么不用证据判定：面板卸载正是「这一页不再由插件渲染」的时刻，而宿主对活跃 tab 的
     * 提交可能还没落地——此刻读 active() 可能仍返回 Expert Group，于是锁会被错误地留在别的
     * 页面上（用户会突然发现右侧栏拖不动）。无条件解锁的方向永远安全：最坏情况是 Expert Group
     * 页在一次 surface 重挂载的空窗里短暂可拖，而重新挂载后的第一次同步会立刻锁回去。
     */
    const releaseRightbarDragLock = () => {
      if (disposed) return;
      try { rightbarDragLock.setLocked(false); } catch { /* 同上。 */ }
      // 面板卸载 = 这一页不再由插件渲染：列宽配比同样立刻交还宿主（下一轮同步会按最新组成
      // 重新写）。它与手柄锁同一方向、同一无条件的理由：宁可短暂地回到宿主默认比例，
      // 也绝不把插件的 grid-template-columns 留在别人的页面上。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响卸载。 */ }
    };
    /**
     * 品牌图标：两个注册面（Better tab 与原生 guide 卡片）共用同一个组件。
     *
     * react 缺失时 createBrandIcon 返回 null，注册描述符里就完全不写 icon 字段——
     * 图标只是外观，缺依赖必须保持「其余注册契约逐字节不变」，绝不因此改变 tab 的行为。
     */
    const brandReact = typeof config.react?.createElement === "function" ? config.react : null;
    const brandIcon = createBrandIcon(brandReact, object(config.primitives));
    // Cordis 对未声明服务的属性读取会抛错；所有可选依赖都经 get/direct 两段式
    // 安全探测。探测到 betterSidebar 后始终由它独占，禁用也绝不回退到 native。
    const optionalService = (name) => {
      try {
        const value = typeof ctx?.get === "function" ? ctx.get(name) : null;
        if (value) return value;
      } catch { /* 服务未安装。 */ }
      try { return ctx?.[name] || null; } catch { return null; }
    };
    const better = config.betterSidebar || optionalService("betterSidebar");
    const sessions = config.sessions || optionalService("sessions");
    const tabs = config.sidebarRightTabs || optionalService("sidebarRightTabs");
    const nativeSidebar = config.sidebarRight || optionalService("sidebarRight");
    const slots = config.slots || optionalService("slots");
    const disposers = [];
    let disposed = false;
    /**
     * 每个 surface 会话的「本次访问」记账（root 与 child 各自独立）。
     *
     * 实测症状：root → child 后右栏空白、刷新 child 才显示；再切回 root 时 root 的右栏又是错的。
     * 根因是宿主右栏 surface/store 按 session 懒创建、binding 由 passive effect 提交，而
     * 插件解析出的当前可见会话可能早于宿主 surface 绑定完成：
     * - Better 0.19.1 的 native surface 对「非当前会话」调用 openTabIn，只要方法存在就返回成功，
     *   但未 mint 的会话会静默 no-op；
     * - 于是在同步通知里发 scoped openTab，既会把 child 的请求落到旧 root binding，又会把目标
     *   永久记成「已打开/已展开」，后续通知再也不会重试。
     *
     * 记账模型（按「访问」而不是按 install 生命周期）：
     * - 「宿主已提交的活跃 surface」每次变化（Better getSnapshot().sessionId 变化；无证据的
     *   native/旧 Better 的当前可见会话）就是一次新的访问，拥有独立的一次打开 + 一次展开预算；
     * - 同一次访问里的重复通知绝不重复打开/展开（尊重用户手动关闭右栏）；
     * - 切走再切回、或同一 sessionId 的 surface 被重新挂载（宿主重新提交活跃会话）都会开新访问，
     *   于是会重新确保页面与右栏——这是 root→child→root 与「刷新 child 再回 root」的自愈路径。
     *   公开 API 观察不到「挂载」本身，只能用上述可观察边界近似：没有任何可观察变化的重挂载
     *   无法区分（属已知限制）。
     *
     * 每条记录里的字段都是「本次访问」的预算：
     * - visitEpoch：这些预算所属的访问代次；旧代次排下的任务在回调里一律作废；
     * - openAttempts / openFailures：本次访问已发出的打开请求次数、其中失败的次数（各有上限）；
     * - openState：idle | opened。只有在「当前可见 + 宿主已提交」时发出的请求才算 opened；
     * - expandDone：本次访问是否已成功调用过 layout.openRightbar（成功即消费，不再重复）；
     * - readinessRetries：本次访问内为「等宿主提交」排过的短重试次数（有上限）。
     * 另外跨会话还有一份 rightbarPresented（见下方「右栏展示生命周期」）：右栏这份**全局**展示
     * 是否已经展开过，它才是「切换 child 时不再重展开」的判据。
     */
    const surfaceRecords = new Map();
    /** 每次访问最多发出的打开请求次数（首次 + 通知/定时器驱动的有界重试）。 */
    const MAX_SURFACE_OPEN_ATTEMPTS = 3;
    /** 每次访问内自动定时重试的上限（其余重试机会由后续通知驱动，同样受上面的总次数约束）。 */
    const MAX_SURFACE_OPEN_RETRIES = 1;
    /** 打开请求的 defer 延迟：至少一个宏任务，排在宿主本次提交（surface/seat/binding）之后。 */
    const SURFACE_OPEN_DELAY_MS = 0;
    /** 打开失败后的短重试间隔（timer 纳入 dispose 清理）。 */
    const SURFACE_OPEN_RETRY_MS = 250;
    /** 「等宿主提交活跃会话」的短重试上限与间隔：通知先到、binding 稍后提交时靠它兜住。 */
    const MAX_READINESS_RETRIES = 3;
    const HOST_COMMIT_RETRY_MS = 250;
    const surfaceRecordOf = (sessionId) => {
      let record = surfaceRecords.get(sessionId);
      if (record === undefined) {
        record = {
          visitEpoch: 0,
          openAttempts: 0,
          openRetries: 0,
          openFailures: 0,
          openState: "idle",
          expandDone: false,
          readinessRetries: 0,
          commitState: "unknown",
          transitionRestore: null,
          continuityRelease: null,
        };
        surfaceRecords.set(sessionId, record);
      }
      return record;
    };
    /**
     * 安全收口一条访问记录上**尚未消费**的过渡抑制句柄。
     *
     * 句柄在 runSurfaceOpen() 里、openSurfaceTab() 之前创建（Better/native 的 openTab 可能同步把
     * 右栏面板置为展开，动画从那一刻开始），正常情况下会由 runRightbarExpand() 交给
     * callOpenRightbar() 并在延迟后恢复。凡是「这次访问不会再调用 layout.openRightbar」的终态
     * （访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、右栏读面不符、dispose…）
     * 都必须在这里立刻恢复，绝不能把 transition:none 留给宿主。
     */
    /** 收口一条访问记录上的连续性遮罩（幂等）。遮罩与过渡抑制是两件事，但生命周期完全一致。 */
    const releaseContinuityOverlayOf = (record) => {
      if (record === undefined || record === null) return false;
      const release = record.continuityRelease ?? null;
      record.continuityRelease = null;
      if (typeof release !== "function") return false;
      try { release(); } catch { /* 释放失败不能阻断其它收尾动作。 */ }
      return true;
    };
    const releaseTransitionRestore = (record, options = {}) => {
      if (record === undefined || record === null) return false;
      // 所有既有收口路径（访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、dispose…）
      // 都必须同时释放连续性遮罩，避免它长期遮住 UI。
      // 唯一例外是「同一个 surface 的访问代次变化」（options.keepContinuity）：那是宿主提交了新的
      // active surface，属于同一次切换窗口的中途通知，此时释放遮罩会把正在覆盖的 DOM 空窗重新暴露
      // 出来。遮罩仍然由「新 panel open / 500ms 兜底 / 打开失败 / 切走 / 终止边沿 / dispose」收口。
      if (options.keepContinuity !== true) releaseContinuityOverlayOf(record);
      const restore = record.transitionRestore ?? null;
      record.transitionRestore = null;
      if (typeof restore !== "function") return false;
      try { restore(); } catch { /* 恢复失败不能阻断其它收尾动作。 */ }
      return true;
    };
    /** 把某条记录绑定到本次访问代次；代次不同就重置该 surface 的访问预算（普通重复通知沿用）。 */
    const beginVisitFor = (sessionId, epoch) => {
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch === epoch) return record;
      // 新访问：先收口上一次访问遗留在记录上的抑制句柄（它属于旧访问，永远不会再被消费）。
      // 连续性遮罩例外保留：同一个 surface 的代次变化只是宿主提交了新的 active surface，切换窗口
      // 还在进行，遮罩必须继续覆盖空窗（由新 panel open / 兜底 / 终止路径收口）。
      releaseTransitionRestore(record, { keepContinuity: true });
      record.visitEpoch = epoch;
      record.openAttempts = 0;
      record.openRetries = 0;
      record.openFailures = 0;
      record.openState = "idle";
      record.expandDone = false;
      record.readinessRetries = 0;
      // 提交确认状态属于一次访问：新访问重新开始判断（否则「已确认 → 缺失」的边沿会反复触发）。
      record.commitState = "unknown";
      return record;
    };
    /**
     * 访问代次：宿主活跃 surface（有证据用 Better snapshot.sessionId，否则用 插件解析出的当前可见会话）
     * 与当前可见会话的组合一旦变化就 +1。作用：
     * - 旧代次排下的打开/展开任务会在回调里被 visitEpoch 校验拦掉（root 的旧 timer 不会污染
     *   child，反之亦然），并且代次变化时顺手取消上一个会话的待执行任务；
     * - 同一 sessionId 的 surface 重新挂载（snapshot 从 null 变回 S，或切走再切回）同样开新访问，
     *   因此会重新确保页面与展开。
     */
    let currentVisitKey = null;
    let currentVisitEpoch = 0;
    let currentVisitSessionId = null;
    /**
     * 同一 sessionId 的 surface 重挂载序号：current 与宿主活跃会话都没变、但宿主读面显示
     * 此前已确认的 expert-group 变成「明确没有 active tab」时 +1（见 openTargets 的边沿检测），
     * 用来强制开启一次新访问。持续缺失不会重复 +1，用户手动切到其它 kind 也不会 +1。
     */
    let currentRemountSerial = 0;
    const beginVisit = (current, hostSessionId) => {
      const key = String(current) + "|" + String(hostSessionId) + "|" + String(currentRemountSerial);
      if (key === currentVisitKey) return currentVisitEpoch;
      currentVisitKey = key;
      currentVisitEpoch += 1;
      // 代次变化：上一个可见会话的遗留任务立刻取消（它们属于旧访问，绝不能在这次访问里执行）。
      if (currentVisitSessionId !== null) {
        cancelSurfaceOpenTimer(currentVisitSessionId);
        cancelRightbarExpand(currentVisitSessionId);
        // 上一个可见会话遗留的过渡抑制同样属于旧访问：立刻收口，绝不留 transition:none。
        // 连续性遮罩要分两种情形：
        // - 可见会话真的换人了（current 变了），或宿主报 null（Better 禁用/未提交的终止标记）：
        //   旧遮罩已经没有意义，必须释放；
        // - 仍然是同一个可见会话，只是宿主提交了新的 active surface / 重挂载序号变化：这正是切换
        //   DOM 空窗的中途通知，遮罩必须继续覆盖（由新 panel open / 500ms 兜底 / 终止路径收口），
        //   否则它会在空窗中间消失，用户依旧看到右栏整块闪一下。
        releaseTransitionRestore(surfaceRecords.get(currentVisitSessionId), {
          keepContinuity: currentVisitSessionId === current && hostSessionId !== null,
        });
      }
      currentVisitSessionId = current;
      return currentVisitEpoch;
    };
    /**
     * 读宿主右栏真正承载的会话（Better 公开状态面；由 setSession() 在切换提交时写入并通知）：
     * - available=false：宿主没有该 API（旧 Better / native 路径），或属性读取/调用抛错 →
     *   调用方走兼容语义（退回 插件解析出的当前可见会话），异常绝不外泄；
     * - available=true, sessionId=null：有 API 但读不到活跃会话（未建立/切换中）→ 视为
     *   「尚未提交」：此时绝不发打开请求（那正是会落到旧 binding 被静默丢弃的情况），只等通知
     *   或有限重试；
     * - available=true, sessionId=S：宿主 binding 已提交到 S，是唯一可信的「已提交」证据。
     */
    const readHostActiveSurface = () => {
      let readSnapshot;
      try {
        const candidate = better?.getSnapshot;
        if (typeof candidate !== "function") return { available: false, sessionId: null };
        readSnapshot = candidate;
      } catch { return { available: false, sessionId: null }; }
      try {
        return { available: true, sessionId: text(object(readSnapshot.call(better)).sessionId, null) };
      } catch { return { available: false, sessionId: null }; }
    };
    /**
     * Expert Group 页的右栏宽度策略（纯插件侧的兼容桥，不修改 DSH 本体）。
     *
     * 目标：这一页的右侧栏宽度是**固定的视口宽度 20%**（1600px 视口 ⇒ 320px 写入宿主），
     * 由 applyRightbarWidth(sessionId) 在页面被激活之前写入宿主 layout store。
     *
     * 背景：右侧栏宽度是宿主 layout store 的 `rightbar` 偏好，为 null 时首次打开会被落成
     * `max(300, round(视口宽 × 45%))`。也就是说「打开时的宽度」只能在第一次 openRightbar
     * 生效之前，由已经写入的偏好决定，因此写入必须留在同步栈里、早于宿主的首次展开。
     *
     * 公开的 ctx.layout（ILayout）只有 openRightbar/closeRightbar 这类展示动作，没有
     * setRightbar；而 LayoutController 运行时实例把布局 store 的 bound actions 放在
     * `layout.panels` 上，其中存在 setRightbar(px)。因此这里逐层 duck-type 取用它：
     * 任何一层缺失、服务代理抛错或调用抛错都必须安全忽略——写入失败绝不能让右栏打开
     * 失败，此时宿主自己的默认值继续生效，契约不变。
     *
     * 记账口径是**按 surface 会话**（rightbarWidths），不是全局布尔值：宿主那份宽度是全局偏好，
     * 全局标记会让会话 B 因为「A 写过」而被跳过。同一会话只在「目标 px 变化」时重写，
     * 重复通知绝不把用户/宿主当前的宽度反复打回 20%。
     */
    /**
     * 「右栏此前已经展示过」的持久标记（跨浏览器刷新）。
     *
     * 症状：Ctrl+F5 / 重新打开浏览器后，第一次在主代理与子代理之间切换又会播放一次右栏展开动画。
     * 根因：rightbarPresented 与 rightbarWidths 一样都是 install 生命周期的内存变量，刷新后归零；
     * 而刷新后宿主 layout store 的 rightbarShown 也回到 false，DEG 必须继续调用
     * layout.openRightbar(true, false)（跳过调用右栏就可能不显示），于是这次调用又带出一次过渡动画。
     *
     * 因此这里把「曾经成功展示过右栏」持久化到 localStorage（带版本号的键）：
     * - 只有 layout.openRightbar 调用成功后才写入；
     * - 读取失败、写入失败（隐私模式、配额、storage 被禁用、无 DOM）都静默回退为「没有标记」，
     *   也就是刷新后仍会正常打开，只是这次会播放一次动画——绝不把异常带出插件；
     * - 标记只影响「这次打开要不要动画」，绝不用于跳过 openRightbar 调用。
     */
    const RIGHTBAR_PRESENTED_KEY = "dsh-expert-group:rightbar-presented:v1";
    /** 安全读持久标记：任何探测/读取异常都按「没有标记」处理。 */
    const readPersistedRightbarPresented = () => {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.getItem !== "function") return false;
        return storage.getItem(RIGHTBAR_PRESENTED_KEY) === "1";
      } catch { return false; }
    };
    /** 安全写持久标记：写入失败只影响「下次刷新要不要动画」，绝不影响本次打开。 */
    const persistRightbarPresented = () => {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.setItem !== "function") return false;
        storage.setItem(RIGHTBAR_PRESENTED_KEY, "1");
        return true;
      } catch { return false; }
    };

    /**
     * 右栏目标探测依赖的公开 DOM 标记清单：探测选择器与 MutationObserver 的 attributeFilter 共用同一份，
     * 避免出现「探测认某个标记、观察却不监听它」的漂移。
     */
    const RIGHTBAR_TARGET_MARKERS = [
      "data-sidebar-right-panel",  // 右栏面板本体
      "data-sidebar-right-open",   // 面板展开状态（动画开始）
      "data-shell-overlay",        // 覆盖层：其父元素即 AppFrame
      "data-rightbar-collapsed",   // AppFrame 折叠状态
      "data-rightbar-instant",     // AppFrame 瞬时展开状态
      // dsh-better-sidebar 0.12.x 的稳定宿主属性：宿主（body 下）出现/变化时也要重新命中目标。
      // 只在本清单末尾追加，绝不删除上面任何旧标记。
      "data-dsh-better-sidebar",
    ];
    /**
     * 自动打开右栏时需要临时抑制过渡的宿主元素：只认宿主已存在的公开 DOM 标记，不依赖 CSS module class，
     * 也不假设某一版 DSH 的组件实现。
     *
     * 1. `[data-sidebar-right-panel]`：右栏面板本体。它可能被宿主（不同 DSH 版本/运行时实现，例如把
     *    面板 portal 到 frame 之外）挂到 AppFrame 子树之外，因此不能假设它继承 frame 上的变量；
     *    唯一依赖的探测契约就是这个公开属性。它自带
     *    `transform: translateX(100%) ↔ none` + `transition: transform var(--ds-transition-duration-slow)`，
     *    是「刷新后首次打开仍看到滑入动画」的真实动画来源，必须单独抑制。
     * 2. AppFrame 根元素：`[data-shell-overlay]` 的父元素（覆盖层是 frame 的直接子节点），兜底认
     *    frame 自己的公开属性 `[data-rightbar-collapsed]` / `[data-rightbar-instant]`——它的
     *    grid-template-columns 过渡同样要抑制。内联自定义属性会沿祖先继承给子树，即使第 2 条落到
     *    frame 的包装元素上，frame 上的过渡也仍读得到被置 0 的变量。
     *
     * 3. dsh-better-sidebar 0.12.x：它在 document.body 下创建带稳定公开属性
     *    `[data-dsh-better-sidebar]` 的宿主，宿主的**直接子节点**里 class 含 panel 的是右面板
     *    （真实 CSS module 名带 hash，所以只能用「直接子 + class 含 panel」这两条稳定特征定位，
     *    绝不硬编码 hash）；右面板自带 transform/width 过渡，是这一版真实可见的滑入动画来源。
     *    同级还有 class 含 bottomPanel 的底部面板：它与右栏展开无关，必须用 :not() 明确排除，
     *    否则会连带抑制它的动画。注意不能写成无边界全文匹配 `[class*='panel']`（那会命中所有
     *    子孙节点，误伤面过大）。
     * 4. `#root`：Better 在它上面写 `margin-right: var(--dsh-sidebar-width)` 并对 margin-right 使用
     *    过渡，展开时整页位移的动画来自这里，因此也要抑制。它本身的 margin-right 原值不做任何改写。
     *
     * 返回描述符对象 { element, kind }：
     * - kind "panel"：真正的右栏面板（原生 [data-sidebar-right-panel] / Better 右面板）。它不仅会滑动，
     *   collapsed 状态还是 transform: translateX(100%) + visibility: hidden，所以除过渡外还要把
     *   transform/visibility 在窗口内钉成 none/visible（见 suppressRightbarTransition 的说明）；
     * - kind "frame"：AppFrame / #root 这类只承担布局过渡的容器，绝不写 transform/visibility。
     *
     * 同一元素被多个选择器命中时只返回一次（只要有一个来源是 panel 就按 panel 处理）；任何探测失败
     * （无 document、querySelector 抛错、DOM 结构不符）都返回已收集到的部分（可能为空）：
     * 调用方按「能抑制多少算多少」处理，绝不抛错。
     */
    const rightbarTransitionTargets = () => {
      const targets = [];
      const byElement = new Map(); // element → targets 下标：同一元素只保留一次
      const push = (element, kind) => {
        if (!element) return;
        const index = byElement.get(element);
        if (index !== undefined) {
          if (kind === "panel") targets[index].kind = "panel";
          return;
        }
        byElement.set(element, targets.length);
        targets.push({ element, kind });
      };
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return targets;
        // 先面板、后 frame：面板是可见动画（与瞬时闪烁）的真实来源。
        push(doc.querySelector("[data-sidebar-right-panel]"), "panel");
        const overlay = doc.querySelector("[data-shell-overlay]");
        if (overlay?.parentElement) push(overlay.parentElement, "frame");
        push(doc.querySelector("[data-rightbar-collapsed]"), "frame");
        push(doc.querySelector("[data-rightbar-instant]"), "frame");
        // dsh-better-sidebar 0.12.x：宿主的直接子节点中 class 含 panel 的右面板（必须排除 bottomPanel）。
        push(doc.querySelector("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"), "panel");
        // Better 的整页 margin-right 过渡挂在 #root 上：只抑制布局过渡，绝不写 transform/visibility。
        push(doc.querySelector("#root"), "frame");
      } catch { /* 探测失败：返回已收集到的部分，其余按「无法抑制」处理。 */ }
      return targets;
    };

    /**
     * AppFrame 是否报告右栏已折叠（用户手动关闭或从未展开）：
     * 折叠时不把 panel 钉成可见——那等于把用户关掉的右栏抢回来。读不到（无 document / querySelector
     * 抛错）时按「未折叠」处理，与旧行为一致。
     */
    const frameRightbarCollapsed = () => {
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return false;
        return doc.querySelector("[data-rightbar-collapsed]") !== null;
      } catch { return false; }
    };

    /**
     * 临时抑制右栏过渡（只在插件自动打开右栏这条路径上使用，作用域仅限本次命中的那几个元素）。
     *
     * 为什么用 CSS 变量 + 内联 transition 而不是改写 DSH：右栏面板的 .panel（transform）与 AppFrame
     * 的 .frame（grid-template-columns）、.handle（left）过渡都读 --ds-transition-duration-slow；
     * 在被抑制的元素上内联置 0ms 后，这一次变化瞬时完成，页面其它动画与用户手动拖拽完全不受影响
     * （不动 document 级样式、不写全局 CSS，也不改 DSH 源码）。内联 transition: none 同时是兜底：
     * 老版本或自定义主题若把过渡写成字面量时长，也仍然是瞬时的；对挂在 frame 之外的右栏面板而言，
     * 它还是唯一能覆盖其自身 transform 过渡的手段（frame 上的变量继承不到它）。
     *
     * 每个目标元素各自保存 transition 与变量的原值；返回的组合恢复函数按同样顺序逐元素还原，
     * 原本没有内联声明就删除。没有任何可用目标时返回 null——调用方照常调用 openRightbar，只是会播放一次动画。
     */
    const RIGHTBAR_TRANSITION_VAR = "--ds-transition-duration-slow";
    const suppressRightbarTransition = () => {
      /** 已经处理过的元素：同一元素被多个选择器命中（或 observer 多次回调）时只处理一次。 */
      const handled = new Set();
      const restores = [];
      /**
       * 对一个目标元素做临时抑制。所有目标都抑制 transition 与过渡时长变量；真正的 panel
       * （pinPanel=true）额外固定 transform:none + visibility:visible。
       *
       * 为什么 panel 还需要这两项：DSH 原生 panel 的 collapsed 状态是
       * transform: translateX(100%) + visibility: hidden，open 才是 none/visible，transition 只负责滑动。
       * 只把 transition 置 0 的话，React 在 surface 切换提交里仍可能先提交 collapsed/hidden 再提交
       * expanded/open，视觉上就是右栏本体「瞬间消失又出现」的闪烁。窗口内把 transform/visibility 直接
       * 内联钉成可见状态、提交完成后按原值（含 priority）归还，才能同时消除滑动与闪烁。
       * #root 与 bottomPanel 绝不做这件事：前者只管布局过渡，后者与右栏展开无关。
       */
      const applyToElement = (element, pinPanel) => {
        let style = null;
        try { style = element.style || null; } catch { style = null; }
        if (style === null || typeof style.setProperty !== "function") return;
        /** 读内联值与优先级：没有这些 API 的最小替身一律按「无内联声明 / 无优先级」处理。 */
        const readValue = (name) => {
          try { return typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : ""; } catch { return ""; }
        };
        const readPriority = (name) => {
          try { return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(name) : ""; } catch { return ""; }
        };
        // 写入顺序固定：先过渡变量、再 transition；真正的 panel 再补 transform/visibility。
        const writes = [
          { name: RIGHTBAR_TRANSITION_VAR, value: "0ms" },
          { name: "transition", value: "none" },
        ];
        if (pinPanel === true) {
          writes.push({ name: "transform", value: "none" }, { name: "visibility", value: "visible" });
        }
        const previous = new Map();
        for (const { name } of writes) previous.set(name, { value: readValue(name), priority: readPriority(name) });
        /**
         * 恢复单个属性：只有当前值**与优先级**都仍等于本次写入时才还原旧值/旧优先级。
         * 抑制窗口内被外部（宿主、主题脚本或页面代码）改写过的属性一律保留外部状态——绝不用旧值
         * 覆盖新值，也绝不动我们没写过的东西；读不到值（style 没有 getPropertyValue）的极简 DOM
         * 替身按旧行为直接还原，兼容最小测试替身与老宿主。
         */
        const restoreIfUnchanged = (name, written, writtenPriority, prev) => {
          try {
            if (typeof style.getPropertyValue === "function" && style.getPropertyValue(name) !== written) return false;
            if (typeof style.getPropertyPriority === "function" && style.getPropertyPriority(name) !== writtenPriority) return false;
            if (prev.value === "" || prev.value === null || prev.value === undefined) style.removeProperty?.(name);
            // 还原旧值时连旧优先级一起还原（原本没有优先级就写空字符串）。
            else style.setProperty(name, prev.value, prev.priority || "");
            return true;
          } catch { return false; /* 单个还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */ }
        };
        try {
          // 内联 !important：主题若用 transition: ... !important 覆盖，这里仍要保证这一次瞬时完成；
          // 不支持 priority 参数的宿主会忽略第三个实参（等价于原来的两参写入），行为安全降级。
          for (const { name, value } of writes) style.setProperty(name, value, "important");
        } catch {
          // 写入失败：把已经写进去的属性还原掉（同样只在仍是本次写入状态时才还原），跳过这个元素。
          for (const { name, value } of writes) {
            restoreIfUnchanged(name, value, readPriority(name), previous.get(name));
          }
          return;
        }
        // 写完后回读优先级：宿主可能规范化或忽略它，恢复判定必须用「实际写入的状态」。
        // 恢复顺序与写入相反（先撤销 panel 的可见性钉住，再恢复 transition 与变量），
        // 这样「只有过渡项」的目标恢复顺序仍与旧实现一致（transition → 变量）。
        const written = [...writes].reverse().map(({ name, value }) => ({
          name,
          value,
          priority: readPriority(name),
          prev: previous.get(name),
        }));
        restores.push(() => {
          // 每个属性各自独立判定：外部改过的保留外部状态，没改过的恢复（原本无内联声明就删除）。
          for (const entry of written) {
            restoreIfUnchanged(entry.name, entry.value, entry.priority, entry.prev);
          }
        });
      };
      const applyTargets = () => {
        // 右栏本身已折叠（用户手动关闭 / 从未展开）时不钉 panel 的可见性：那是把用户关掉的右栏抢回来。
        const collapsed = frameRightbarCollapsed();
        for (const target of rightbarTransitionTargets()) {
          if (handled.has(target.element)) continue;
          handled.add(target.element);
          applyToElement(target.element, target.kind === "panel" && collapsed !== true);
        }
      };
      // 当前可查到的目标立刻内联抑制：调用方保证这一步发生在 openSurfaceTab() 之前，
      // 因为 Better/native 的 openTab 可能同步展开 panel，动画在那时就已经开始。
      applyTargets();
      /**
       * 面板可能比这次抑制更晚挂载（seat 尚未 mint 出 surface、面板还没插到 DOM 上）：
       * 用一个**短生命周期** MutationObserver 盯住 documentElement/body 的子树，并监听五个公开标记
       * 的属性变化：data-sidebar-right-panel（面板本体）、data-sidebar-right-open（面板展开状态）、
       * data-shell-overlay（覆盖层，其父元素即 AppFrame）、data-rightbar-collapsed 与
       * data-rightbar-instant（AppFrame 的折叠/瞬时状态）。一旦面板出现或这些公开状态变化，就对
       * 新增目标执行同样的逐元素抑制（去重由 handled 保证）。
       * 仍然只改这几个元素的内联样式：不注入全局 style，也不动 document/body 的全局 transition。
       * 没有 MutationObserver、没有 document、observe 抛错时静默降级为「只抑制当前已存在的目标」。
       * 观察者由返回的恢复句柄 disconnect（dispose 与延迟恢复都会走它）。
       */
      let observer = null;
      try {
        const doc = globalThis.document;
        const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
        const root = doc?.documentElement ?? doc?.body ?? null;
        if (typeof Observer === "function" && root !== null && typeof root === "object") {
          observer = new Observer(() => { applyTargets(); });
          try {
            observer.observe(root, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: [...RIGHTBAR_TARGET_MARKERS],
            });
          } catch {
            // observe 失败：断开并放弃观察，只保留已经写好的内联抑制。
            try { observer.disconnect(); } catch { /* 断开失败也不能阻断后续恢复。 */ }
            observer = null;
          }
        }
      } catch { observer = null; }
      if (restores.length === 0 && observer === null) return null;
      /** 恢复句柄：先 disconnect（避免恢复后又被重新抑制），再逐元素还原样式。 */
      return () => {
        const current = observer;
        observer = null;
        if (current !== null) {
          try { current.disconnect(); } catch { /* 断开失败不能阻断样式还原。 */ }
        }
        for (const restore of restores) {
          try { restore(); } catch { /* 单个目标还原失败不能阻断其它目标。 */ }
        }
      };
    };

    /**
     * 过渡抑制的兜底恢复延迟（毫秒）。
     *
     * 后台标签页、节能模式或被隐藏的 iframe 里 requestAnimationFrame 可能被严重节流甚至永不触发，
     * 因此**即使 RAF 可用也必须同时**安排一个有界 fallback timer：两条路径任一先到就取消另一方并
     * 恢复样式。250ms 足以覆盖正常两帧提交（约 32ms），又不会让 frame 长期停在 transition:none。
     */
    const RIGHTBAR_INSTANT_FALLBACK_MS = 250;
    /**
     * 安排过渡抑制的恢复（同一时刻只保留一个待恢复句柄，重复打开先恢复上一个）。
     *
     * 时机：必须在宿主完成这次提交之后才还原，否则过渡会在列宽变化落地前被重新打开。两条互备路径：
     * - 连排两帧 requestAnimationFrame：第一帧足够让 React 把宿主 store 的列宽变化提交到 DOM，
     *   第二帧在无过渡状态下完成布局后再还原；
     * - 有界 fallback timer：RAF 被节流/永不触发时保底恢复（没有 RAF 时它是唯一路径）；
     * - 任一触发即取消另一方，保证只恢复一次、也不留下没人消费的任务；
     * - 两类调度都不可用时立刻还原；任何调度异常都只影响「这次打开有没有动画」，绝不影响右栏显示。
     */
    let pendingInstantRestore = null; // { restore, cancel }
    const flushInstantRestore = () => {
      const pending = pendingInstantRestore;
      if (pending === null) return;
      pendingInstantRestore = null;
      try { pending.cancel(); } catch { /* 取消失败不影响立即还原。 */ }
      try { pending.restore(); } catch { /* 还原失败不能影响宿主布局。 */ }
    };
    const scheduleInstantRestore = (restore) => {
      flushInstantRestore();
      let settled = false;
      let firstFrame = null;
      let secondFrame = null;
      let fallbackTimer = null;
      /** 取消两类尚未执行的任务（恢复前与 dispose 共用）。 */
      const cancelPending = () => {
        try { if (firstFrame !== null) globalThis.cancelAnimationFrame?.(firstFrame); } catch { /* 可选 API。 */ }
        try { if (secondFrame !== null) globalThis.cancelAnimationFrame?.(secondFrame); } catch { /* 可选 API。 */ }
        try { if (fallbackTimer !== null) globalThis.clearTimeout?.(fallbackTimer); } catch { /* 可选 API。 */ }
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        // 先取消另一方，保证只恢复一次，也不留没人消费的任务。
        cancelPending();
        if (pendingInstantRestore !== null && pendingInstantRestore.restore === restore) pendingInstantRestore = null;
        try { restore(); } catch { /* 见上：只影响这次打开有没有动画。 */ }
      };
      const cancel = () => { settled = true; cancelPending(); };
      // fallback 先排：RAF 被节流时它是唯一保底，绝不让 frame 长期停在 transition:none。
      try {
        fallbackTimer = globalThis.setTimeout(settle, RIGHTBAR_INSTANT_FALLBACK_MS);
      } catch { fallbackTimer = null; }
      let rafScheduled = false;
      try {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === "function") {
          firstFrame = raf(() => { secondFrame = raf(settle); });
          rafScheduled = true;
        }
      } catch { /* RAF 不可用：完全依赖上面的 fallback timer。 */ }
      // 两类调度都不可用：立刻还原（最坏情况是这次打开又播放一次动画，绝不留抑制态）。
      if (fallbackTimer === null && rafScheduled !== true) {
        settle();
        return;
      }
      pendingInstantRestore = { restore, cancel };
    };

    /** 视觉连续性遮罩单例：每次 capture 先释放上一个，保证同时最多一个遮罩。 */
    const continuityOverlay = createNativeRightbarContinuityOverlay();

    /**
     * 本安装生命周期内、按 surface 会话记账的右栏宽度：sessionId → 已写入的 px。
     *
     * 为什么必须按会话隔离：右栏宽度是宿主 layout store 里的一份**全局**偏好，插件为会话 A
     * 写入的值会留在宿主里；如果沿用「整个 install 只写一次」的全局标记，会话 B 首次激活就会
     * 因为「A 已经写过」而被跳过，B 只能继承 A 的（可能已经过期的）宽度——这正是要修掉的
     * 「session A 的动作覆盖 session B 的状态」。按 sessionId 各自记账后，A 的写入只标记 A，
     * B 激活时一定会写自己的 20%，两者互不覆盖。
     */
    const rightbarWidths = new Map();
    /**
     * sessionId → 上次成功写入宽度时所用的**视口宽度**（px）。
     *
     * 与 rightbarWidths 同为 per-session 的目标值记账（同样只在 install 生命周期内有效、
     * dispose 一并清空），但记的是「那份像素值是按哪个视口算出来的」。窗口最大化 / 全屏后
     * 视口变化，这份记账就是常驻同步路径发现「必须重算」的判据（见 rightbarWidthViewportChanged）。
     */
    const rightbarWidthViewports = new Map();
    /**
     * 最近一次成功写入宽度的 surface 会话：宿主那份全局宽度当前归谁。
     *
     * 宿主 setRightbar 写的是全局 layout store；因此 session A → B → A 的每次 surface 切换都必须
     * 重新把当前会话的宽度写回：宿主里那份值此刻属于上一个会话，不能只因为 rightbarWidths 里
     * 留着 A 的旧目标值就跳过。同一次激活内的重复通知仍由各会话自己的记账去重，避免在 Expert
     * Group 页保持活跃时无意义地覆盖宿主状态。
     */
    let rightbarWidthSurfaceSessionId = null;
    /**
     * sessionId → 该会话的宽度模式（"expert" / "other" / "split-pending"）。
     *
     * 为什么必须按会话归属：宿主那份宽度虽然是全局的，但「这份宽度代表哪一种组成」只对写它的
     * 那个会话成立。用全局单值记 mode 时，root-a 的 other / split-pending 会被当成 root-b 的
     * 现状——B 的首次宽度预置被跳过、B 的 50% 判定被抑制。归属迁移时旧会话的 transient 记账
     * 随归属一起失效（见 claimRightbarWidthOwnership），新会话自己的条目一概不动。
     */
    const rightbarWidthModes = new Map();
    /**
     * openTargets 刚刚成功预置宽度的会话集合：用于避免同一同步栈末尾的活跃页确认再次重复写入。
     * 一旦证据表明当前不是 Expert Group，或这次预置被消费，就立即清除**该会话**的标记。
     */
    const rightbarWidthPreparedSessions = new Set();
    /** 最近一次被公开 active() 证明确实处于 Expert Group 页、且宽度已经落到宿主的会话集合。 */
    const rightbarWidthActiveSessions = new Set();
    /**
     * 同一个「未收敛的宽度 mismatch」的恢复写入记账：sessionId → { target, actualWidth, attempts }。
     *
     * 只记**恢复边沿**（宿主夺回了那份 px）的写入，不记首次接管 / 从其它分页返回 Expert Group /
     * 分栏事务的 50% 与收口 20% 这些正常写入；因此它既不会挡住正常写入，也不会让正常轮询把预算
     * 重置（见 RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS）。
     *
     * 事件同一性由 (target, 观测到的实际宽度) 决定，其中 target 是**按当前视口算出来的预期值**
     * （不是「上次成功写入的值」，见 recoverRightbarWidth）：
     * - 没有记账、预期 target 变了、或观测到的实际宽度变了 → 新的一次 mismatch 事件，重新获得完整预算；
     * - 三者都相同 → 同一个未收敛事件，预算用尽后一律拒绝写入。
     *
     * 「预期 target 变了」必须用当前视口重算：宿主持续 clamp 时视口挪一两个像素、20% 取整后仍是同一个
     * px，那不是新事件；只有窗口真正最大化到取整结果改变才是一次新事件。
     */
    const rightbarWidthRecoveries = new Map();
    /** 清除某个会话的恢复写入记账（收敛 / 所有权周期变化 / dispose 共用）。 */
    const clearRightbarWidthRecovery = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      rightbarWidthRecoveries.delete(sessionId);
    };
    /**
     * 恢复边沿的**有界预算**判定：返回 true 表示这一次「宿主夺回了宽度」的恢复写入允许执行。
     *
     * 只在恢复边沿调用（统一入口是 recoverRightbarWidth：recomputeOwnedWidth 的 hostReclaimed 分支
     * 与 confirmed 分支的同一判据），因此首次接管、从其它分页返回、分栏事务的 50% / 收口 20% 等
     * 正常写入完全不受影响。
     *
     * target 参数必须是**按当前视口算出来的预期值**（`Math.round(视口宽度 × 比例)`），不能传「上次
     * 成功写入的值」：宿主持续 clamp 时，视口 3200 → 3201 → 3202 的预期值都是 640，用预期值做事件
     * 同一性，这些视口变化才会被正确地归入同一个未收敛事件、不再重新获得预算。
     *
     * 预算在**调用时**消耗（而不是写入成功后）：写入本身几乎不会失败，而「尝试过就计数」能保证
     * 即使宿主每次都把写入吞掉，也不会出现无限重试——这正是本预算要挡住的形状。
     */
    const allowRightbarRecoveryWrite = (sessionId, target, actualWidth) => {
      if (sessionId === null || sessionId === undefined) return false;
      if (typeof target !== "number" || Number.isFinite(target) !== true) return false;
      if (typeof actualWidth !== "number" || Number.isFinite(actualWidth) !== true) return false;
      const recorded = rightbarWidthRecoveries.get(sessionId);
      const sameEvent = recorded !== undefined
        && recorded.target === target
        && Math.abs(recorded.actualWidth - actualWidth) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX;
      if (sameEvent !== true) {
        // 新的一次 mismatch 事件（首次观测 / target 变了 / 观测到的实际宽度变了）。
        rightbarWidthRecoveries.set(sessionId, { target, actualWidth, attempts: 1 });
        return true;
      }
      if (recorded.attempts >= RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS) return false;
      recorded.attempts += 1;
      return true;
    };
    /** 读取某个会话当前的宽度模式；没有已确认模式时返回 null。 */
    const widthModeOf = (sessionId) => (sessionId === null || sessionId === undefined
      ? null
      : rightbarWidthModes.get(sessionId) ?? null);
    /** 写入（mode 非空）或清除（mode 为 null）某个会话的宽度模式。 */
    const setWidthMode = (sessionId, mode) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthModes.get(sessionId) ?? null;
      const next = mode === null || mode === undefined ? null : mode;
      if (next === null) rightbarWidthModes.delete(sessionId);
      else rightbarWidthModes.set(sessionId, next);
      // 模式（= 宽度所有权周期）**发生变化**时，恢复事件记账随之失效：新周期里的第一次 mismatch
      // 是新事件，重新获得完整预算。两条刻意收紧的边界：
      // - 只在**已有非空模式**被换掉（expert ↔ other、或交还成 null）时清除。null → expert 是
      //   「首次确认这一份 expert 所有权」，恢复记账仍属于同一个周期，不能被重置；
      // - 无条件清除会让 confirmed 分支每一轮同步都重置预算（它每轮都用同一个值调用本函数），
      //   正常轮询就能无限重写——正是本预算要挡住的形状。
      if (previous !== null && previous !== next) clearRightbarWidthRecovery(sessionId);
    };
    /** 某个会话是否刚被 openTargets 预置过宽度（同一同步栈内不重复写）。 */
    const isWidthPrepared = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthPreparedSessions.has(sessionId);
    /** 标记/清除某个会话的「刚预置过宽度」状态。 */
    const setWidthPrepared = (sessionId, prepared) => {
      if (sessionId === null || sessionId === undefined) return;
      if (prepared === true) rightbarWidthPreparedSessions.add(sessionId);
      else rightbarWidthPreparedSessions.delete(sessionId);
    };
    /** 某个会话的 Expert Group 页是否已被 active() 证明落地（宽度已经成功写到宿主）。 */
    const isWidthActive = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthActiveSessions.has(sessionId);
    /** 标记/清除某个会话的「已确认活跃」状态。 */
    const setWidthActive = (sessionId, active) => {
      if (sessionId === null || sessionId === undefined) return;
      if (active === true) rightbarWidthActiveSessions.add(sessionId);
      else rightbarWidthActiveSessions.delete(sessionId);
    };
    /** 清除某个会话的全部 transient 宽度记账（模式 + 预置 + 已确认活跃）。 */
    const clearRightbarWidthMarks = (sessionId) => {
      setWidthMode(sessionId, null);
      setWidthPrepared(sessionId, false);
      setWidthActive(sessionId, false);
      // 模式/所有权周期结束时，这个会话的「恢复事件」记账一并失效：下一次 mismatch 是新事件。
      clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 把宿主那份全局宽度的归属迁移到 sessionId（每次成功写入后调用）。
     *
     * 旧主人的 transient 记账（模式 / 预置 / 已确认活跃）描述的是「宿主那份宽度属于它」时的状态，
     * 归属一换就不再成立：必须一起失效，否则 A 的 other / split-pending 会在 B 激活时被当成 B 的
     * 现状（B 的首次预置被跳过），切回 A 时又会挡住 A 自己的 50% 重放。新会话自己的条目一概不动；
     * per-session 的目标值 rightbarWidths 不受影响，切回时仍按该会话自己的目标重估。
     */
    const claimRightbarWidthOwnership = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthSurfaceSessionId;
      if (previous !== null && previous !== sessionId) clearRightbarWidthMarks(previous);
      rightbarWidthSurfaceSessionId = sessionId;
    };
    /**
     * 首次从 Expert Group-only pane 创建子代理 pane 的**按会话隔离**事务表：sessionId → 事务。
     *
     * 归属与并发边界：
     * - busy 只对本会话成立：同一 session 的第二次 split 仍被防重入（绝不产生竞争 pane/重复 tab），
     *   但别的 session 的在途事务不再阻塞本会话——用全局单例记这件事时，A 未收口的在途事务会让
     *   切到 B 之后的行尾箭头直接拿到 busy（用户看到的是「点了没反应」）。
     * - token / deadline / commit / cancel 全部按 token 反查**自己那一条**：迟到的 observer 回调、
     *   deadline 回调或取消请求只能收口它自己的事务，既不结算也不回滚别的会话。
     * - 会话切换、无可见 surface 与 dispose 只逐条取消表里的事务（各自清理自己的 transient 记账），
     *   宿主那份全局宽度的归属仍由当前 surface 的同步链路决定，绝不由旧事务的迟到回调改写。
     */
    const rightbarSplitTransactions = new Map();
    /** 按 token 反查仍然在途的事务；已被 commit/cancel 收口的 token 一律返回 null（迟到回调的安全边界）。 */
    const transactionOf = (token) => {
      if (token === null || token === undefined) return null;
      for (const transaction of rightbarSplitTransactions.values()) {
        if (transaction.token === token) return transaction;
      }
      return null;
    };
    /** 从表里移除自己那一条（按 identity 比对，绝不误删同会话后来居上的新事务）。 */
    const releaseSidebarSplitTransaction = (transaction) => {
      if (rightbarSplitTransactions.get(transaction.sessionId) === transaction) {
        rightbarSplitTransactions.delete(transaction.sessionId);
      }
    };
    /** 逐条收口全部在途事务（无可见 surface / dispose）：每条只清理自己所属 session 的 transient 记账。 */
    const cancelAllSidebarSplits = (reason) => {
      for (const transaction of [...rightbarSplitTransactions.values()]) {
        try { cancelSidebarSplit(transaction.token, { reason }); } catch { /* 单条收口失败不能阻断其余事务与 disposer。 */ }
      }
    };
    /** 分栏事务自己的 deadline 句柄，不能借用 panel 的 opening 记录或 observer 生命周期。 */
    const clearSidebarSplitDeadline = (transaction) => {
      if (transaction === null || transaction === undefined) return;
      const timer = transaction.deadlineTimer;
      transaction.deadlineTimer = null;
      if (timer === null || timer === undefined) return;
      try { globalThis.clearTimeout?.(timer); } catch { /* 收口路径必须继续执行。 */ }
    };
    /**
     * 为某个 surface 会话写入固定 20% 的右栏宽度；返回是否真的写了。
     *
     * 写入时机：只有该会话的 Expert Group surface 被激活（openTargets 里的当前可见会话）时才写，
     * 并且**同一会话不重复改写**——宿主里的这个值可能已经是用户拖拽或宿主自己算出的结果；
     * 视口宽度变化导致同一会话的目标 px 变化时会重写一次。
     *
     * 20% 是精确比例：插件不做任何最小值 clamp（宿主 setRightbar 自己有 clamp，它才是权威边界）。
     *
     * 写入前会 best-effort 同步宿主自己那份视口缓存：宿主 clamp 用的是 AppFrame 根元素宽度，
     * 冷启动时它可能还停在旧值，会把目标宽度夹小（2560 视口写 1280，宿主按 1280 缓存夹成 896），
     * 而插件的记账已认为「这个视口写过」，偏差不会自愈。同步值只取**能唯一、可靠读到的 AppFrame
     * 宽度**（见 hostAppFrameWidthOf），绝不拿 window.innerWidth 顶替；读不到就完全跳过同步。
     * 目标像素值仍按 window.innerWidth 的比例换算，本次已读取的同一个视口宽度贯穿始终。
     *
     * 兼容：layout 服务缺失、服务代理读属性抛错、setRightbar 不是函数或调用抛错时一律返回 false
     * 且**不记账**——写入失败不算应用，后续通知仍可重试，宿主自己的默认宽度继续生效。
     * 可选的视口同步 action 缺失、读属性抛错或调用抛错都不阻断既有 setRightbar 路径。
     */
    const applyRightbarWidth = (sessionId, ratio = RIGHTBAR_WIDTH_RATIO, force = false) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 视口宽度读不到（无 DOM 环境）就没有可换算的比例：放弃写入，保留宿主当前值。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const normalizedRatio = Number(ratio);
      if (!Number.isFinite(normalizedRatio) || normalizedRatio <= 0) return false;
      const target = Math.round(viewportWidth * normalizedRatio);
      if (force !== true && rightbarWidths.get(sessionId) === target) return false;
      const layout = config.layout || optionalService("layout");
      // panels 与两个 action 的属性读取必须**逐项独立隔离**：可选的 setViewportWidth 读属性抛错
      // （Cordis 服务代理对未声明属性就会抛）绝不能把必要的 setRightbar 一起挡掉。
      let panels = null;
      try { panels = layout?.panels ?? null; } catch { panels = null; }
      const setRightbar = methodOf(panels, "setRightbar");
      if (setRightbar === null) return false;
      const setViewportWidth = methodOf(panels, "setViewportWidth");
      // 宿主 setRightbar 按 layout store 的 viewportWidth 做上限 clamp，而那份缓存来自 AppFrame 根
      // 元素宽度（冷启动时可能还停在旧值，把目标宽度夹小）。只有能唯一、可靠读到 AppFrame 宽度时
      // 才先把它同步给宿主；读不到 AppFrame、尺寸非法时**不同步、不猜测宿主尺寸**，直接走原有写入。
      const appFrameWidth = hostAppFrameWidthOf();
      if (appFrameWidth !== null) {
        try { setViewportWidth?.call(panels, appFrameWidth); } catch { /* 校准不是展示侧栏的前置条件，失败时保留原有写入兼容路径。 */ }
      }
      try {
        // bound action 是闭包，不依赖 this；仍显式带上接收者，兼容将来改成方法式绑定。
        setRightbar.call(panels, target);
      } catch {
        // 调用失败不算写入成功：保持未记账（后续通知仍可重试），宿主当前宽度继续生效。
        return false;
      }
      rightbarWidths.set(sessionId, target);
      // 连同「这次换算用的视口宽度」一起记账：它才是「宿主那份像素值是否还对应当前视口」的判据，
      // 也是常驻同步路径发现窗口最大化 / 全屏 / 拖拽后必须重新写入的唯一来源。
      rightbarWidthViewports.set(sessionId, viewportWidth);
      // 写入成功即接管宿主那份全局宽度：旧会话的 transient 记账随归属一起失效（见 claim 说明）。
      claimRightbarWidthOwnership(sessionId);
      return true;
    };
    /**
     * 某个会话「上次写入宽度时用的视口宽度」是否已经变了（窗口最大化 / 全屏 / 拖拽 / 旋转屏幕）。
     *
     * 右栏宽度是视口比例，视口一变，之前写下的像素值就不再代表 20% / 50%：必须按新视口重新
     * 换算并写入。这是常驻同步路径**唯一**的重新写入判据——同一视口下的重复通知仍然一个字节
     * 都不写（保留「宿主里那份值可能是用户拖拽结果」的原有去重语义）。
     *
     * 没有写过宽度（没有记账）时返回 false：那种情况由「首次接管 / 从其它分页返回」等既有
     * 分支负责写入，不在这里重复承担。
     */
    const rightbarWidthViewportChanged = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const recorded = rightbarWidthViewports.get(sessionId);
      if (recorded === undefined) return false;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      return recorded !== viewportWidth;
    };
    /**
     * 读当前会话对应右栏面板的**实际渲染宽度**（px）。
     *
     * 这是「宿主里那份宽度到底是谁写的」唯一可验证的公开证据：只读
     * [data-sidebar-right-panel] 与 getBoundingClientRect()，不注册 class、不读任何私有状态。
     *
     * 一律 fail-closed（返回 null）：面板归属无法精确解析（零个 / 多个 / 缺
     * data-sidebar-right-session）、没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数
     * （null / 0 / NaN / 负值 / 非数字）——这些都不构成「宽度等于某个值」的证据，调用方必须保留
     * 宿主当前值，等后续可验证的同步。
     */
    const readRightbarPanelWidth = (sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") return null;
      let panel = null;
      try { panel = rightbarPanelForSession(globalThis.document, sessionId); } catch { return null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try {
        rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
      } catch { return null; }
      if (rect === null || typeof rect !== "object") return null;
      let width = null;
      try { width = Number(rect.width); } catch { return null; }
      if (Number.isFinite(width) !== true || width <= 0) return null;
      return width;
    };
    /**
     * 宿主里那份右栏宽度是否**仍是插件上一次成功写入的 target**（见 rightbarWidths）。
     *
     * 为什么需要它：other 模式的宽度是**可调**的，用户在其它右侧分页上拖出的宽度由宿主持有。
     * 只有「面板实际渲染宽度 == 插件上次写的 px」才能证明宿主里那份值仍是插件写的（或用户恰好
     * 拖回了同一个值，等价于没有改动），此时按模式重算视口才不会覆盖用户的拖拽结果。
     *
     * 任何一环读不出来（没有上次 target / 面板宽度读不到 / 宽度对不上）都返回 false：宁可这一次
     * 不重算，也绝不猜测写入——宿主当前值原样保留，后续 confirmed / other 分支仍会按证据重估。
     */
    const hostWidthMatchesPluginTarget = (sessionId) => {
      const ownership = rightbarOwnershipOf(sessionId);
      return ownership !== null && ownership.matches === true;
    };
    /**
     * 一次性读出「宿主那份宽度 vs 插件 target」的**所有权观测**；读不出来时返回 null（fail-closed）。
     *
     * 返回 { target, actualWidth, matches, differs }：
     * - matches：面板实际渲染宽度仍等于插件上次写入的 target（所有权仍在插件手里）；
     * - differs：面板实际渲染宽度明确不等于 target（宿主夺回了那份 px）。
     *
     * 为什么合成一个函数：同一轮同步里既要判 matches 又要判 differs，还会消费恢复预算，分开调用会
     * 把同一份 DOM 证据读两遍（readRightbarPanelWidth → getBoundingClientRect 会触发布局）。
     * 任何一环读不出来（没有 target / 面板定位不到 / 宽度不是有限正数）一律返回 null——读不出来就
     * 不构成任何证据，调用方必须原样保留宿主当前值。
     */
    const rightbarOwnershipOf = (sessionId) => {
      const target = rightbarWidths.get(sessionId);
      if (typeof target !== "number" || Number.isFinite(target) !== true) return null;
      const actualWidth = readRightbarPanelWidth(sessionId);
      if (actualWidth === null) return null;
      const delta = Math.abs(actualWidth - target);
      return {
        target,
        actualWidth,
        matches: delta <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
        differs: delta > RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
      };
    };
    /**
     * 消费一次「所有权观测」：观测到收敛（实际宽度 == target）就清掉恢复事件记账。
     *
     * 这正是「状态清除」的唯一判据：宿主终于把 target 提交到 DOM 上之后，下一次 mismatch 必须是
     * **新的一次恢复事件**（重新获得完整预算），而不是被上一次已经用尽的预算永久挡住。
     * 读不出观测（null）时什么都不做——没有证据就不清除，保持原有记账。
     */
    const settleRightbarRecovery = (sessionId, ownership) => {
      if (ownership !== null && ownership.matches === true) clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 恢复 / 视口重写的**统一入口**：所有「实际宽度明确偏离当前视口预期 target」的写入都走这里。
     *
     * 为什么必须统一：恢复写入的判据散落在两条分支上（confirmed 分支与 recomputeOwnedWidth 的
     * unknown 分支）时，只要其中一条把「视口变化」当成**独立**边沿、不消费预算，宿主持续 clamp 的
     * 场景就能被无限绕过——视口从 3200 挪到 3201 / 3202，20% 取整后仍是同一个 target 640，
     * 每一次视口变化都变成「一次新的恢复事件」，用户轻微拖动窗口边缘就会与宿主的 clamp 无限拉锯。
     * 因此两条分支共用这一份判定（per-session，按预期 target + 观测到的实际宽度记账）。
     *
     * 三条口径：
     * - **没有公开 DOM 证据（ownership 为 null：面板定位不到，或 getBoundingClientRect().width
     *   不是有限正数）就是不写**：恢复 / 视口重算入口一律 fail-closed，一个字节都不写，既不消费
     *   mismatch 预算，也绝不新建 / 重置一次 mismatch 事件。右栏宽度是宿主 layout store 里的**全局**
     *   偏好，插件只在能证明「这份 px 现在是谁的」时才允许改写它；读面不可用期间没有任何证据说明
     *   面板宽度偏离了 target，写下去就是无据改写宿主状态（而且是每次视口变化 / 通知 / 轮询都写的
     *   无界改写）。宿主那份值原样保留，等后续**可验证**的同步（readRightbarPanelWidth 恢复可读）——
     *   这条收紧只作用于恢复 / 视口重算入口，首次接管、从其它分页返回、分栏事务收口等正常写入
     *   语义完全不受影响；
     * - 实际宽度已经等于**当前视口下预期**的 target：这不是 mismatch，只是视口记账需要更新（例如
     *   宿主已经自己落到了正确宽度），正常写一次即可，不消费预算；
     * - 实际宽度明确偏离预期 target：同一个 (预期 target, 实际宽度) 的写入共用 per-session 预算，
     *   用尽后一律拒绝；预期 target 真正改变（窗口最大化导致取整结果变化）时是一次**新事件**，
     *   重新获得完整预算。
     *
     * 调用方负责「该不该尝试写入」的边沿判定（视口变化 / 宿主夺回宽度 / 模式证据），这里只负责
     * 「这次写入允不允许」：不读任何私有状态、不新增轮询或定时器。
     */
    const recoverRightbarWidth = (sessionId, ratio, ownership) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 没有任何公开 DOM 证据：直接 fail-closed。这里刻意不调用 applyRightbarWidth（更不带 force），
      // 因此既不会写宿主宽度，也不会触碰恢复预算记账（不新建、不重置、不消费）。
      if (ownership === null || ownership === undefined) return false;
      // 预期 target 必须与 applyRightbarWidth 用同一套换算（同一视口宽度 × 同一比例、同样取整），
      // 否则事件同一性会把「同一份预期值」判成两次不同事件。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const expectedTarget = Math.round(viewportWidth * ratio);
      if (Math.abs(ownership.actualWidth - expectedTarget) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX) {
        // 实际宽度已经等于预期 target：只是视口记账需要更新，不属于 mismatch，不消费预算。
        return applyRightbarWidth(sessionId, ratio, true) === true;
      }
      if (allowRightbarRecoveryWrite(sessionId, expectedTarget, ownership.actualWidth) !== true) return false;
      return applyRightbarWidth(sessionId, ratio, true) === true;
    };
    /**
     * 组成证据为 unknown 时，按**本会话已经证明过的宽度模式**重算「视口变化 / 宿主夺回宽度」。
     *
     * 两条触发边沿（都只作用于 expert 模式，见下面的 other 分支说明）：
     * 1. 视口宽度变了（窗口最大化 / 全屏 / 拖拽窗口边缘）：那份 px 不再代表原来的比例；
     * 2. **宿主夺回了那份 px**（面板实际渲染宽度 != 插件上次写入的 target）：DSH 重启后宿主从
     *    持久化布局恢复它自己那份旧值的时序正是「视口没变但那份值已经不是插件的」，
     *    只按视口判据永远等不到重算（见 rightbarOwnershipOf 的 differs）。
     *
     * 为什么「面板宽度 != 插件 target」就足以证明宿主夺回了所有权（只在 expert 模式消费）：
     * Expert Group 页的手柄由插件锁住（rightbarDragLock），用户在这一页**拖不动**右栏；而 20%
     * 又是插件独占的固定比例，不存在「用户在该页自定义宽度」的语义。因此这一页上面板宽度偏离
     * target 只有两种可能：宿主自己重渲染回了它那份持久化值，或用户恰好拖到了同一个值（等价于
     * 没有改动）。两种情形都应当把 20% 写回去——但**必须有界**（见 recoverRightbarWidth）。
     *
     * 为什么 unknown 仍然可以重算：组成读面（inventory / DOM）回答的是「当前右栏里有哪些页」，
     * 而这里消费的是本会话**自己**的宽度记账——它记的是「宿主那份 px 是按哪个比例、哪个视口
     * 写下去的」，与组成读面无关。视口一变（窗口最大化 / 全屏 / 拖拽窗口边缘），那份 px 就不再
     * 代表原来的比例（实测：1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640），因此
     * 必须按同一比例重算；否则读面暂不可用的宿主会一直停在过期宽度上。
     *
     * fail-closed 边界（绝不放松）：
     * - 没有任何模式证据（mode 为空且 prepared/active 都没有）时返回 false，一个字节都不写；
     *   组成读面不可用时**绝不臆测** 20% 或 50%，也绝不把 unknown 当成 confirmed；
     * - **没有宽度 DOM 证据（面板宽度读不出来）时同样一个字节都不写**：expert 模式虽然不要求
     *   「面板宽度仍等于插件 target」（那是 other 的可调保护），但**要求这条读面本身可用**——
     *   ownership 为 null 时 recoverRightbarWidth 直接 fail-closed，既不写宽度也不动恢复预算
     *   （见该函数第一条口径）。模式证据只回答「该写哪个比例」，不构成「可以无据改写宿主全局
     *   宽度」的证据；
     * - **other 模式额外要求宿主宽度所有权**：other 的 50% 是可调状态，用户可以在该页手动拖宽，
     *   仅凭「模式是 other」就重算会覆盖用户的拖拽结果。因此只有 hostWidthMatchesPluginTarget
     *   证明宿主里那份 px 仍是插件上次写的 target 时才重算；读不到或对不上一律不写（见该函数说明）。
     *   expert 模式不受此限制：20% 是插件**独占**的固定比例，不存在「用户在该页拖宽」的语义；
     * - **other 模式只认视口变化这一条边沿**：宿主夺回宽度在 other 模式里正是「用户拖过一次」
     *   的典型形状，据此重算会覆盖用户的拖拽结果，因此那一模式绝不消费 hostReclaimed；
     *   other 的视口重算还额外要求 hostWidthMatchesPluginTarget（实际宽度仍等于插件上次的 target），
     *   这条真实用户拖拽保护不受本预算逻辑影响，绝不放宽；
     * - expert 模式去重：视口没变、且宿主那份值仍等于插件 target 时什么都不做；
     * - 写入失败由 applyRightbarWidth 自己保证不记账，后续通知仍可重试；
     * - 手柄锁与组合归属语义完全不变：本函数不碰 rightbarDragLock，也不改写任何 transient 记账
     *   （prepared / active 保持原样，因此下一次视口变化仍然有据可依）。
     */
    const recomputeOwnedWidth = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const viewportChanged = rightbarWidthViewportChanged(sessionId) === true;
      // expert 模式下还有第二条触发边沿：宿主已经夺回那份 px（面板宽度不再等于插件 target）。
      // DSH 重启后宿主恢复持久化旧值的时序正是「视口没变但那份值已经不是插件的」，只按视口判据
      // 永远等不到重算。一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
      const ownership = rightbarOwnershipOf(sessionId);
      // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
      settleRightbarRecovery(sessionId, ownership);
      const hostReclaimed = ownership !== null && ownership.differs === true;
      if (viewportChanged !== true && hostReclaimed !== true) return false;
      const mode = widthModeOf(sessionId);
      // 只有已确认的模式才给出比例：expert = 20%，other = 50%。split-pending 不会走到这里
      // （在途事务在 rightbarDragSyncImpl 里更早 return，收口时也必然被改写成 expert/other/null），
      // 万一出现也一律不猜。
      let ratio = null;
      if (mode === "expert") {
        // 20% 是插件独占的固定比例：视口变化与「宿主夺回宽度」两条边沿都必须重算。
        ratio = RIGHTBAR_WIDTH_RATIO;
      } else if (mode === "other") {
        // other 是可调模式，**只认视口变化这一条边沿**：
        // - 宿主夺回宽度（面板宽度 != 插件 target）在 other 模式里恰恰是「用户拖过一次」的
        //   典型形状，绝不能据此重算，否则会把用户的拖拽结果覆盖成 50%；
        // - 视口变化本身也必须先证明所有权（面板宽度仍等于插件 target）才允许重算；
        // 读不到面板宽度时所有权不成立 → 一个字节都不写，用户的宽度原样保留。
        if (viewportChanged !== true) return false;
        if (ownership === null || ownership.matches !== true) return false;
        ratio = OTHER_RIGHTBAR_WIDTH_RATIO;
      } else if (mode === null && (isWidthPrepared(sessionId) || isWidthActive(sessionId))) {
        // prepared / active 只由**成功的 20% 写入**置位（openTargets 预置，或 confirmed 分支 /
        // 事务收口时按 20% 恢复成功），因此它们证明的模式就是 expert；这里绝不据此推断 50%。
        ratio = RIGHTBAR_WIDTH_RATIO;
      }
      if (ratio === null) return false;
      // 写入判据与 confirmed 分支**共用**同一份有界预算（见 recoverRightbarWidth）：视口变化本身不再
      // 自动等于「可以再写一次」——取整后仍是同一个 target 的视口变化不是新的 mismatch 事件，
      // 否则宿主持续 clamp 时轻微拖动窗口边缘就能无限重写。
      return recoverRightbarWidth(sessionId, ratio, ownership) === true;
    };
    /**
     * 自动展开右侧栏：按 surface 会话隔离 + 异步延迟执行。
     *
     * 两次实测反馈决定了这里的两个硬约束：
     * 1. 「新会话右栏偶尔短暂弹出又收回，必须 Ctrl+F5」——宿主 ui-sidebar-right 的
     *    RightbarSeat 用 syncPresentation({ shown: false }) → layout.closeRightbar() 上报
     *    「这个 surface 还没展开」，而宿主右栏 surface 的 expanded 状态是按 sessionId 隔离、
     *    由页面打开（openTab → planSetExpanded(true)）才置位的。在同一同步栈里紧跟页面打开
     *    调 layout.openRightbar，会赶在宿主完成本次提交（surface 建立、seat 就位）之前，
     *    随后被 seat 的「未展开」报文反手关掉——表现为闪一下又收回。因此展开必须 defer 到
     *    宿主提交之后：这里只安排一个异步回调，回调里才真正调用宿主公开契约
     *    ctx.layout.openRightbar(true, false)。
     * 2. 「点进子代理会话后右栏不展开」——child 是另一个 sessionId，有自己的 surface 与
     *    expanded 状态；用「整个 install 只展开一次」的全局布尔值管理，child 永远拿不到
     *    自己的机会。因此逐次访问的记账按 sessionId 隔离。
     *    （注意：上面那条历史结论针对的是「永不复位的整个 install 布尔值」；下面新增的
     *    rightbarPresented 记的是**右栏这份全局展示**，宿主明确报告 surface 没了就会复位，
     *    所以它既不会让 child 永远拿不到机会，也不会在切换 child 时重复展开。）
     *
     * 记账规则（每个 surface 会话独立 + 一份跨会话的「右栏展示」记账）：
     * - 每个 surface 的每次访问最多展开一次：调用成功即在本访问内消费，同一访问的后续通知
     *   绝不再排（用户此时手动关掉右栏，本次访问不会把它重新拉开）；
     * - 跨会话另记一份 rightbarPresented（右栏展示生命周期）：成功展开过一次后，继续切换到
     *   别的 child 只切换页面/tab 内容（openTab / openTabIn / scoped openTab），绝不再调
     *   layout.openRightbar——否则每进入一个 surface 都会重展开一次，表现为右栏闪烁；
     * - 只有宿主**明确**报告 Expert Group surface 没了（此前已确认的 active tab 变成
     *   「没有 active tab」）才结束这次展示生命周期，下一次访问允许再展开一次；
     * - 调用抛错：记一次失败，最多 RIGHTBAR_EXPAND_MAX_ATTEMPTS 次尝试（含短延迟自动重试），
     *   避免把「布局 store 临时不可用」变成永久失败；
     * - 宿主这一层没有 openRightbar：不消耗机会、也不排自动重试，交给后续通知再试——
     *   服务稍后可用时仍能展开一次，同时不会留下没人消费的定时器。
     *
     * 只对「当前可见 surface」调用（插件解析出的当前可见会话）：右栏是全局的，为后台 root 展开
     * 等于替用户切走当前视图，而页面都没打开就展开只会拉出一个空右栏。
     *
     * 安全边界：layout 服务缺失、Cordis 服务代理读属性即抛错、openRightbar 调用抛错、
     * 调度器（setTimeout）本身抛错或被 deferred 回调跨过 dispose，全部静默吞掉。自动展开
     * 只是锦上添花，绝不能让 Expert Group 页面打不开（页面默认选择仍由 Better openTab /
     * native openNativeTab 完成）。
     */
    const RIGHTBAR_EXPAND_DELAY_MS = 0; // 至少一个宏任务：排到宿主本次提交（surface/seat）之后
    const RIGHTBAR_EXPAND_RETRY_MS = 250; // 调用抛错后的短重试间隔
    const RIGHTBAR_EXPAND_MAX_ATTEMPTS = 3; // 每个 surface 的调用尝试上限（含自动重试）
    /** 已排队的异步展开：sessionId → timer handle（同一会话同时只保留一个）。 */
    const rightbarExpandTimers = new Map();
    /**
     * 调用失败次数：sessionId → attempts（只有真的调用过并抛错才累加）。
     * 属于「右栏展示生命周期」的预算：宿主明确报告 surface 没了（见 openTargets 的重挂载
     * 边沿）时整体清零，新生命周期重新拥有完整的尝试次数。
     */
    const rightbarExpandFailures = new Map();
    /**
     * 右栏「展示生命周期」记账（跨 surface 会话共用一份）。
     *
     * 实测症状：从主代理首次切到子代理时右栏首次打开动画正常；首次打开完成后再继续切换不同
     * 子代理，右栏会闪烁。根因与记账范围有关：展开机会原先按「每个 session 的每次访问」记，
     * 每进入一个新 surface 都会再排一次 layout.openRightbar(true, false)，而 DSH 的公开 API
     * 会同步改写右栏展示状态，于是内容切换的同时右栏被反复重展开。
     *
     * 语义修正：右栏是**全局**的一份展示，不是每个 session 一份。成功展开过一次就置位，之后
     * 切换 surface 只切换对应页面/tab 的内容，绝不再调用 layout.openRightbar。
     *
     * 复位条件只有一个（保守、只认宿主的明确证据）：宿主读面显示此前已确认的 expert-group
     * 变成「没有 active tab」（seat 卸载 / 布局重置 / 用户关掉右栏，见 openTargets 的重挂载
     * 边沿）时结束本次展示生命周期——下一次访问既能重新确保页面，也允许再展开一次；同一时刻
     * rightbarExpandFailures 一并清零，展开失败计数绝不跨生命周期继承。
     * 读面缺失或抛错（旧 Better / native 的 unknown）不做任何推断：那时无法区分「用户手动关掉」
     * 与「surface 还在」，一律保持「已展示」语义，绝不重新拉开右栏（尊重用户的显式操作）。
     */
    let rightbarPresented = false;
    /**
     * 「右栏此前已经展示过」的持久标记（含本次 install 生命周期内刚成功展开过的情形）。
     * 与 rightbarPresented 的区别：后者是可被宿主「明确缺失」边沿复位的内存态，前者跨刷新存活，
     * 只决定「这次自动打开是否需要播放动画」，绝不用于跳过 openRightbar 调用。
     */
    let rightbarPresentedPersisted = readPersistedRightbarPresented();

    /** 取消某个会话尚未执行的异步展开（dispose 与「已消费」路径共用）。 */
    const cancelRightbarExpand = (sessionId) => {
      const timer = rightbarExpandTimers.get(sessionId);
      if (timer === undefined) return;
      rightbarExpandTimers.delete(sessionId);
      try {
        // 定时器句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的异步展开：插件卸载后不得再操作宿主 layout。 */
    const cancelAllRightbarExpands = () => {
      for (const sessionId of [...rightbarExpandTimers.keys()]) cancelRightbarExpand(sessionId);
    };

    /**
     * 真正调用宿主动作，返回 ok / unavailable / failed 供调用方记账。
     * 每次调用都重新取一次服务（与宽度预置同一条路径：优先注入的 config.layout，回退可选
     * 服务查找），这样「服务稍后才可用」也能被后续尝试接住。
     */
    const callOpenRightbar = (preparedRestore = null) => {
      // 准备好的抑制句柄来自 runSurfaceOpen()（在 openTab 之前就已生效）；一旦拿不到 layout action，
      // 必须立刻收口，绝不能把 transition:none 留在宿主上。
      const releasePrepared = () => {
        if (typeof preparedRestore !== "function") return;
        try { preparedRestore(); } catch { /* 恢复失败不能阻断其它收尾。 */ }
      };
      const layout = config.layout || optionalService("layout");
      let openRightbar = null;
      try {
        const candidate = layout?.openRightbar;
        if (typeof candidate === "function") openRightbar = candidate;
      } catch {
        // Cordis 服务代理对未声明属性会抛错：按「宿主没有这个 action」处理。
        releasePrepared();
        return "unavailable";
      }
      if (openRightbar === null) {
        releasePrepared();
        return "unavailable";
      }
      // 刷新后（本生命周期内已经展示过右栏）仍然必须调用 openRightbar：宿主 layout store 的
      // rightbarShown 刷新后可能是 false，跳过调用右栏就可能不显示。区别只在于这次打开要
      // 瞬时完成：优先复用「页面打开之前就已经开始」的抑制句柄（panel 可能在 openTab 时就展开，
      // 那时动画已经开始）；只有没有句柄时才按现有逻辑临时创建，兼容独立重试与旧调用路径。
      // 临时创建同样拿不到目标（无 DOM / 元素缺失）时为 null，行为与旧版本完全一致。
      const restoreTransition = typeof preparedRestore === "function"
        ? preparedRestore
        : (rightbarPresentedPersisted ? suppressRightbarTransition() : null);
      let result = "ok";
      try {
        // 宿主动作是方法式绑定：显式带上接收者，避免将来 layout 改成类实例后丢失 this。
        openRightbar.call(layout, true, false);
      } catch {
        // 调用抛错不影响页面打开：只影响这一次自动展开，失败会被记账。
        result = "failed";
      }
      // 恢复必须晚于宿主的这次提交：绝不在同一同步栈里还原，否则过渡会在列宽落地前重新生效。
      if (restoreTransition !== null) scheduleInstantRestore(restoreTransition);
      return result;
    };

    /**
     * 为某次访问排队一次异步展开（同一访问只会成功展开一次）。
     * 已消费、已排队、代次过期、已 dispose 或环境没有可用调度器时什么都不做——绝不阻塞页面打开。
     */
    const scheduleRightbarExpand = (sessionId, epoch, delay) => {
      if (disposed || sessionId === null) return false;
      // 右栏这次展示生命周期已经展开过：连定时器都不排（切换 surface 时不产生任何 layout 调用）。
      if (rightbarPresented) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.expandDone) return false;
      if (rightbarExpandTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          rightbarExpandTimers.delete(sessionId);
          runRightbarExpand(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动展开，页面打开与其它行为都不受影响。
        return false;
      }
      rightbarExpandTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 展开体。三重校验后才调用 layout：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 不得污染新 surface）；
     * 2. 仍是当前可见会话（右栏是全局的，绝不为后台会话展开）；
     * 3. 本次访问的页面已经落地（openState === "opened"）——宿主有证据时还要求宿主已提交，
     *    否则会把内容展开到旧 surface 或被 seat 立刻关掉。
     * 成功一次即 expandDone（同一访问内不再重复，尊重用户随后手动关闭），并置位右栏展示
     * 生命周期 rightbarPresented（跨 surface 会话共用，切换 child 时不再重复展开）。
     */
    const runRightbarExpand = (sessionId, epoch) => {
      if (disposed) return;
      const record = surfaceRecordOf(sessionId);
      // 右栏已经在本展示生命周期里展开过（例如另一个 surface 的展开先成功）：绝不再调宿主 layout，
      // 同时收口本次访问可能已经开始的抑制（它不会再被消费）。
      if (rightbarPresented) {
        releaseTransitionRestore(record);
        return;
      }
      // 旧代次：句柄属于别的访问，绝不能在这里收口（那会撕掉新访问的抑制）。
      if (record.visitEpoch !== epoch) return;
      if (record.expandDone) return;
      if ((rightbarExpandFailures.get(sessionId) || 0) >= RIGHTBAR_EXPAND_MAX_ATTEMPTS) {
        releaseTransitionRestore(record);
        return;
      }
      if (currentSurfaceSessionId() !== sessionId) {
        // 用户已切走：这次访问不会再为它调用 openRightbar，收口抑制（切回时是新访问、会重新抑制）。
        releaseTransitionRestore(record);
        return;
      }
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        releaseTransitionRestore(record);
        return;
      }
      if (record.openState !== "opened") {
        // 页面还没落地：后续 runSurfaceOpen 会在下一次 openTab 之前重新抑制，这里先收口避免悬空。
        releaseTransitionRestore(record);
        return;
      }
      // 句柄所有权移交：callOpenRightbar 负责在调用 layout.openRightbar 之后统一延迟恢复，
      // 或在拿不到 layout action 时立刻收口。
      const preparedRestore = typeof record.transitionRestore === "function" ? record.transitionRestore : null;
      record.transitionRestore = null;
      const result = callOpenRightbar(preparedRestore);
      if (result === "ok") {
        record.expandDone = true;
        // 置位全局展示生命周期：之后切换 surface 只切内容，不再重复展开（消除右栏闪烁）。
        rightbarPresented = true;
        // 持久标记：刷新后仍能识别「右栏曾经展示过」，下一次自动打开以无过渡方式提交，
        // 不再重新播放一次展开动画（写入失败只影响下次刷新有没有动画，静默回退）。
        rightbarPresentedPersisted = true;
        persistRightbarPresented();
        rightbarExpandFailures.delete(sessionId);
        return;
      }
      // 宿主没有这个 action：不消耗机会、不排自动重试，等下一次通知再试。
      if (result === "unavailable") return;
      const failures = (rightbarExpandFailures.get(sessionId) || 0) + 1;
      rightbarExpandFailures.set(sessionId, failures);
      // 失败重试同样必须异步（回到宿主提交之后），且次数有上限，不会无限重排定时器；
      // 排不出重试任务时收口句柄（此时句柄通常已交给 callOpenRightbar 消费，这里是兜底）。
      if (failures >= RIGHTBAR_EXPAND_MAX_ATTEMPTS
        || scheduleRightbarExpand(sessionId, epoch, RIGHTBAR_EXPAND_RETRY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };

    /**
     * 为「当前可见会话的本次访问」安排一次异步展开。
     * 页面必须先落地（openState === "opened"），否则展开只会拉出一个空右栏；本次访问已经展开过
     * 就绝不再排——用户手动关闭右栏后，本次访问的重复通知不会把它重新拉开。
     * 另有全局闸门：右栏这份展示（跨 surface 会话只有一份）已经展开过时，后续切换只切换内容，
     * 绝不再调用 layout.openRightbar（rightbarPresented 只控制「要不要调用 openRightbar」）。
     */
    const scheduleCurrentSurfaceExpand = () => {
      const current = currentSurfaceSessionId();
      const record = current === null ? undefined : surfaceRecords.get(current);
      if (rightbarPresented) {
        // 已经展示过右栏：这次 surface 切换只需要「把新 panel 的 expanded transform 提交过程变瞬时」，
        // 不需要再调用 layout.openRightbar。因此把 openTab 前准备好的抑制句柄转交给延迟恢复
        // （两帧 RAF + 250ms fallback），覆盖 React 把 data-sidebar-right-open/transform 提交到 DOM
        // 的窗口；绝不能在这里直接 release，否则新 panel 仍会播放一次从右侧滑入的动画。
        const preparedRestore = typeof record?.transitionRestore === "function" ? record.transitionRestore : null;
        if (preparedRestore === null) return;
        record.transitionRestore = null;
        scheduleInstantRestore(preparedRestore);
        return;
      }
      if (current === null) return;
      if (record === undefined) return;
      if (record.visitEpoch !== currentVisitEpoch) return;
      if (record.openState !== "opened") return;
      if (record.expandDone) return;
      // 排程失败（没有可用调度器 / setTimeout 抛错）：这次访问不会再调用 openRightbar，
      // 立刻收口抑制句柄，绝不让 observer 与内联样式悬在宿主上。
      if (scheduleRightbarExpand(current, record.visitEpoch, RIGHTBAR_EXPAND_DELAY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };
    const nativeSidebarFor = (target) => {
      if (typeof config.sidebarRightForSession === "function") {
        try { return config.sidebarRightForSession(target, ctx); } catch { return null; }
      }
      try {
        const scoped = typeof sessions?.scope === "function" ? sessions.scope(target) : null;
        return scoped?.get?.("sidebarRight") || scoped?.sidebarRight || null;
      } catch { return null; }
    };
    /**
     * 自动打开 Expert Group 页面 + 展开右栏（每次 sessions/Better 通知都调用一次）。
     *
     * 目标只有一个：**当前可见会话**（插件解析出的当前可见会话）。宿主右栏是按 session 懒创建的，
     * 对非当前会话的 scoped open 会被静默 no-op（Better 0.19.1 的 native surface 对未 mint 的
     * 会话就是「openTabIn 存在即返回成功」）。因此这里：
     * 1. 绝不为后台 root/child 预发打开请求——它们成为 current 时自然会拿到属于自己的一次访问；
     * 2. 打开请求不在同步栈里发出，而是 defer 一个宏任务，等宿主把 surface/binding 提交完
     *    （runSurfaceOpen 会复核访问代次、插件解析出的当前可见会话，以及 Better 已提交的活跃会话）；
     * 3. 宿主明确还没提交时只做有限次「等提交」重试，绝不把请求落到旧 binding、也绝不把它
     *    记成已完成；
     * 4. 页面真正落地后才排程 layout.openRightbar(true, false)（同样 defer、同样按访问记账，
     *    成功一次即消费，用户的后续手动关闭在本次访问内不会被覆盖）。
     *
     * 宽度策略：Expert Group 页的右栏宽度固定为视口宽度的 20%（RIGHTBAR_WIDTH_RATIO），
     * 由 applyRightbarWidth(current) 在页面打开之前按 surface 会话写入宿主 layout store；
     * 插件不写第二套宽度状态、不操作 DOM/grid，也不通过 openTab 参数伪造 width。同一会话
     * 的重复通知不重复改写，切换会话时为新会话写它自己的一份（见 rightbarWidths 的说明）。
     * 注意写入仍在同步栈里执行，必须早于宿主第一次展开。
     *
     * 拖拽手柄锁也在这条访问路径上重估（requestRightbarDragSync）：宿主报告「当前活跃 tab
     * 就是 Expert Group」时锁住 [data-side=rightbar]，切到别的页面立刻交还宿主。
     *
     * 顺序是硬约束：宽度写入（同步）→ 打开页面（deferred）→ 展开右栏（deferred）。宿主
     * ui-sidebar-right 的 RightbarSeat 在右栏 surface 还没挂载时会以
     * syncPresentation({ shown: false }) → layout.closeRightbar() 收尾，任何同步/过早的展开都会
     * 被它立刻关掉。
     *
     * 契约不变：Better Sidebar 可用时由它独占（用户禁用它则不自动打开，也绝不回退 native
     * 注册）；否则走 native（含旧 openTabIn 兼容）。打开失败保持未打开状态等待后续通知。
     */
    /**
     * 读取宿主右栏的公开只读 tab inventory（**跨 pane** 的全量已提交 tab 表）。
     *
     * 为什么需要它：宿主刷新后会从持久化布局恢复**全部 pane** 的 tab，而 `active()` 只返回
     * 当前活跃 pane 的 active tab。只看 active() 无法回答「这个会话的 Expert Group 页是否已经
     * 存在于另一个 pane」，于是插件会在当前 pane 再开一个重复的 Expert Group 页
     * （多 pane/分页下刷新一次多一个重复页）。
     *
     * 读面缺失（旧宿主没有 openTabs）、读属性抛错、没有 getSnapshot、返回非数组/null 或调用
     * 抛错时一律返回 null：调用方据此**完全**回退旧的 active() 兼容语义，绝不把「读不到」
     * 当成「不存在」，也绝不当成「已存在」。
     */
    const readSurfaceOpenTabs = () => {
      let inventory = null;
      try { inventory = nativeSidebar?.openTabs ?? null; } catch { return null; }
      const getSnapshot = methodOf(inventory, "getSnapshot");
      if (getSnapshot === null) return null;
      try {
        const snapshot = getSnapshot.call(inventory);
        return Array.isArray(snapshot) ? snapshot : null;
      } catch { return null; }
    };
    /**
     * 读取已渲染右栏的页面组成：DOM 能看到其它 tab 时，它是跨 pane「其它页存在」的直接证据。
     *
     * DOM 只提供 tabId，不提供 kind、更不提供 sessionId；这两样都只能来自 openTabs inventory。
     * 因此**归属**是这里的第一判据：一个节点只有在 inventory 里明确属于本次查询的 sessionId 时，
     * 才算这个会话的组成。
     *
     * 会话切换时旧会话的 tab 节点可能还留在 DOM 里（宿主 React 重挂载窗口）：它在 inventory 里
     * 挂在别的 sessionId 名下，因此在这里拿不到 kind，落进下面的 unknown 桶——既不会被当成当前
     * 会话的「其它页」（这正是修复点：只按 tabId 建全局 kind 表时，root-a 的残留节点会把 root-b
     * 判成 50%），也不会被当成 Expert Group-only。
     *
     * fail-closed 语义（与修复前一致，不能放松）：
     * - 节点没有 tabId、或 tabId 在 inventory 里找不到**属于本次会话**的归属（含挂在别的会话
     *   名下的旧节点）→ "unknown"（读不到 ≠ 不存在）；
     * - inventory 不可用（返回 null）时所有非 Expert Group 节点都归入 unknown；
     * - 已知是 Expert Group 的 tabId（含 DockKit 生成的 kind+计数器形态）永远不是「其它页」。
     * 只有「明确属于当前会话、且 kind 不是 Expert Group」的节点才返回 "other"。
     *
     * 面板归属同样按 session 精确解析（rightbarPanelForSession）：DOM 里可能同时残留多个 session
     * 的面板（React 重挂载窗口），querySelector 的首个命中不能证明归属，读它的 tab 节点就会把别的
     * 会话的页算成本会话的组成。零个/多个匹配、或现代宿主里当前面板缺归属标记都返回 null
     * （＝这一面在本轮读不到），绝不退回全局第一个面板。
     *
     * sessionId 省略（传 null）时不做任何归属判定：调用方只用来探测 DOM 读面本身是否可用
     * （见 compositionReadFacesUnavailable），因此这里保留旧的兼容读法（querySelector 的命中），
     * 只回答「DOM 读面在不在」，它的返回值也不会被当成任何会话的组成证据。
     */
    const readRightbarDomComposition = (sessionId = null) => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelector !== "function") return null;
      let panel = null;
      if (typeof sessionId === "string" && sessionId !== "") {
        // 实际 session 判定：只读这个会话自己的面板。
        panel = rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
      } else {
        // 探测读面能力（无归属判定）。
        try { panel = doc.querySelector(RIGHTBAR_PANEL_SELECTOR); } catch { return null; }
      }
      if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
      let nodes;
      try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return null; }
      const inventory = readSurfaceOpenTabs();
      // 只登记「明确属于当前会话」的 tabId → kind；别的会话与 sessionId 缺失的记录一律不参与判定。
      const kindByTabId = new Map();
      if (inventory !== null && sessionId !== null && sessionId !== undefined) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const tabId = text(candidate.tabId, null);
            const kind = text(candidate.kind, text(candidate.type, null));
            if (tabId !== null && kind !== null) kindByTabId.set(tabId, kind);
          } catch {
            // 单条坏记录不阻断其它 tab 的归属；无法归属的节点仍由下面的 fail-closed 分支处理。
          }
        }
      }
      let hasOther = false;
      let hasUnknown = false;
      for (const node of nodes) {
        let tabId = null;
        try { tabId = text(node?.getAttribute?.("data-dockkit-tab"), null); } catch { tabId = null; }
        if (tabId === null) { hasUnknown = true; continue; }
        if (EXPERT_GROUP_TAB_IDS.has(tabId) || isGeneratedExpertGroupTabId(tabId)) continue;
        if (!kindByTabId.has(tabId)) { hasUnknown = true; continue; }
        const kind = kindByTabId.get(tabId);
        if (EXPERT_GROUP_TAB_IDS.has(kind)) continue;
        hasOther = true;
      }
      if (hasOther) return "other";
      if (hasUnknown) return "unknown";
      return "expert-only";
    };

    /** 同步栈内只读取「其它页是否已经存在」，不触碰 active()，避免改变宿主提交时序。 */
    const hasOtherRightbarPage = (sessionId) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return true;
          } catch {
            // 单条坏记录不构成其它页的正向证据。
          }
        }
      }
      // DOM 读面同样只认属于该会话的节点：旧会话残留的 tab 不算当前会话的其它页。
      return readRightbarDomComposition(sessionId) === "other";
    };

    /**
     * 跨 pane 的「这个会话的 Expert Group 页已经存在」判定。
     *
     * 命中口径与 activeTabEvidenceOf 的证据口径一致（同 sessionId + kind 为 expert-group）：
     * inventory 是全部 pane 已提交 tab 的并集，因此这里**不区分 pane**——这正是修复点，
     * 非活跃 pane 里的同一个页也是「已经存在」。tabId/contentId 不参与判定：它们是关闭/定位
     * 用的元数据，缺失不影响「页面已存在」这一事实。
     *
     * 返回值语义（两种 false 对调用方是同一件事：回退旧的打开语义）：
     * - true：读面证明页面已存在；
     * - false：读面证明不存在，或读面根本不可用（fail-closed，绝不因为读不到就跳过打开）。
     */
    const hasExistingExpertGroupTab = (sessionId) => {
      if (sessionId === null) return false;
      const inventory = readSurfaceOpenTabs();
      if (inventory === null) return false;
      for (const entry of inventory) {
        try {
          // 单条 inventory 记录来自宿主对象；某些代理对象字段读取失败时，不能让
          // 一条坏记录阻断其它记录和旧的打开回退语义。
          const candidate = object(entry);
          if (text(candidate.sessionId, null) !== sessionId) continue;
          if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
          return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    /**
     * 保守的「页面真的提交成 active」证据（只用插件已能访问的公开读面，不依赖未公开的 DSH 改动）。
     *
     * 为什么需要它：better.openTab() 返回 void；在它之外，插件此前只能证明宿主活跃会话是谁。
     * 即使调用没抛错，宿主右栏的 surface 也可能还没 mint / tab 还没提交（DSH SidebarRight 对
     * 未挂载会话的 open 会静默 no-op）。DSH 公开的 sidebarRight.active()（active tab of the
     * active pane，未挂载时返回 undefined）正好回答「这个 tab 到底有没有落地」。
     *
     * 读法：优先按目标会话解析出的 scoped sidebarRight，其次当前挂载的 nativeSidebar；只要其中
     * 任意一个有 active() 就用它。返回值：
     * - "confirmed"：active tab 的 kind/type 就是 expert-group（真正落地）；
     * - "missing"：读面存在但没有 active tab / 没有 kind（尚未 mint 或被静默 no-op）；
     * - "other"：active tab 是别的 kind（例如用户手动切走的 tab）；
     * - "unknown"：宿主没有该读面、属性读取或调用抛错、或宿主的活跃会话还不是目标会话
     *   （此时 active() 读的是别的 surface，不能当证据）——调用方必须退回旧 native / 旧 Better
     *   的兼容语义，绝不能让老版本失效。
     */
    const activeTabEvidenceOf = (sessionId) => {
      const host = readHostActiveSurface();
      // 宿主有活跃会话证据但还没提交到目标：此刻 active() 读的是别的 surface，不能当证据。
      if (host.available && host.sessionId !== sessionId) return "unknown";
      let reader = null;
      let owner = null;
      try {
        const scoped = nativeSidebarFor(sessionId);
        if (typeof scoped?.active === "function") { reader = scoped.active; owner = scoped; }
      } catch { /* 服务代理读取即抛错：按「没有读面」处理。 */ }
      if (reader === null) {
        try {
          if (typeof nativeSidebar?.active === "function") { reader = nativeSidebar.active; owner = nativeSidebar; }
        } catch { /* 同上。 */ }
      }
      if (reader === null) return "unknown";
      try {
        // 方法式绑定：显式带上接收者，避免将来改成类实例后丢失 this。
        const tab = reader.call(owner);
        const kind = text(object(tab).kind, text(object(tab).type, null));
        if (kind === null) return "missing";
        return EXPERT_GROUP_TAB_IDS.has(kind) ? "confirmed" : "other";
      } catch {
        // 调用抛错按「无证据」处理：自动打开降级为既有语义，绝不影响页面打开。
        return "unknown";
      }
    };
    /**
     * 组合 active()、openTabs 与宿主 DOM 的证据：active() 只回答当前 pane，不能代表整个右栏。
     *
     * 只要 openTabs 或 DOM 证明当前右栏存在其它 tab，就进入 50% 可调模式；仅有 Expert Group
     * 证据时才进入 20% 锁定模式。missing 与 unknown 保持独立：前者解锁但不改宽度，后者
     * 不改变已确认状态，避免读面暂态把用户宽度覆盖掉；两种组合读面都不可用时不采信 active-only
     * 证据，防止把一个 pane 的暂态读数误当成整个右栏的 Expert Group-only 组成。
     */
    const rightbarCompositionEvidenceOf = (sessionId, activeEvidence) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return "other";
          } catch {
            // 坏记录不能否定 active() 的证据；DOM 读面仍有机会给出其它页的正向证据。
          }
        }
      }
      // DOM 按 sessionId 归属：只有 inventory 明确算在当前会话名下的节点才参与组成判定，
      // 旧会话残留或无法归属的节点都归入 unknown，绝不推断成其它页。
      const domComposition = readRightbarDomComposition(sessionId);
      if (domComposition === "other") return "other";
      if (domComposition === "unknown") return "unknown";
      // active() 只够让既有宿主继续锁住当前 Expert Group 手柄；它本身不足以支撑会创建新 pane
      // 的 split 事务，否则会把一个 pane 的暂态读数扩展成整个右栏的 ownership 结论。
      // beginSidebarSplit 因此把这个 unknown 当作 fail-closed，唯一例外是「连组合读面都不存在」
      // 的 active-only 兼容宿主：那里的判据由 isActiveOnlySplitCompatible 单独给出（见其说明）。
      if (inventory === null && domComposition === null && activeEvidence === "confirmed") return "unknown";
      return activeEvidence;
    };
    /**
     * 两个组合读面是否都不可用（openTabs inventory 读不到 + 右栏 DOM 也读不到）。
     *
     * 这就是「旧宿主 / 读面还没就绪」的宿主形状：插件手上只剩 active() 这一份公开证据。
     * 读函数自己已经把「没有该 API / 属性读取抛错 / 调用抛错」吞成 null，因此这里的 try/catch
     * 只是防御服务代理在读取瞬间抛错，一律按「这一面不可用」处理（读不到 ≠ 不存在）。
     */
    const compositionReadFacesUnavailable = () => {
      let inventoryUnavailable = false;
      let domUnavailable = false;
      try { inventoryUnavailable = readSurfaceOpenTabs() === null; } catch { inventoryUnavailable = true; }
      // 这里只探测 DOM 读面本身是否可用（不传 sessionId，不做归属判定）：只要面板与节点查询
      // 能读，返回值就不是 null（最坏是保守的 "unknown"），读面可用性结论与修复前一致。
      try { domUnavailable = readRightbarDomComposition() === null; } catch { domUnavailable = true; }
      return inventoryUnavailable && domUnavailable;
    };
    /**
     * 发出一次 Expert Group 页面打开请求（Better 优先，native 回退）。
     * 返回 true 表示请求已成功发出；false 表示当前宿主无法定位该 surface（保持未打开状态，
     * 留给后续会话/设置通知重试）。Better openTab 返回 void，调用未抛错即视为已发出。
     */
    const openSurfaceTab = (target) => {
      if (better) {
        if (typeof better.openTab !== "function") return false;
        try {
          // target 必须显式为 right，第二参数是 Better Sidebar 的 SessionScope；
          // scope.sessionId 接受任意 surface 会话 id（root 或 child）。
          better.openTab({ type: "expert-group", target: "right" }, { sessionId: target });
          return true;
        } catch { return false; }
      }
      try {
        // native 用 openNativeTab 的 boolean 返回值判定「已成功发起」。
        return openNativeTab(target) === true;
      } catch { return false; }
    };

    /** 已排队的「打开请求」：sessionId → timer handle（与展开 timer 分开记账，dispose 一并清理）。 */
    const surfaceOpenTimers = new Map();
    /** 取消某个会话尚未执行的打开请求。 */
    const cancelSurfaceOpenTimer = (sessionId) => {
      const timer = surfaceOpenTimers.get(sessionId);
      if (timer === undefined) return;
      surfaceOpenTimers.delete(sessionId);
      try {
        // 句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的打开请求（dispose 用）。 */
    const cancelAllSurfaceOpens = () => {
      for (const sessionId of [...surfaceOpenTimers.keys()]) cancelSurfaceOpenTimer(sessionId);
    };

    /**
     * 为某次访问排队一次「打开页面」请求：一律 defer 到至少一个宏任务之后，等宿主把
     * surface/binding 提交完再发；同一次访问同时只保留一个待执行任务。
     * 代次过期、已落地、次数用尽、已排队、已 dispose 或没有可用调度器时什么都不做。
     */
    const scheduleSurfaceOpen = (sessionId, epoch, delay) => {
      if (disposed || sessionId === null) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.openState === "opened") return false;
      if (record.openAttempts >= MAX_SURFACE_OPEN_ATTEMPTS) return false;
      if (surfaceOpenTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          surfaceOpenTimers.delete(sessionId);
          runSurfaceOpen(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动打开，安装与其它行为都不受影响。
        return false;
      }
      surfaceOpenTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 打开体。发请求前逐条校验：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 绝不污染新 surface）；
     * 2. 用户仍在这个会话上（插件解析出的当前可见会话 已切走就直接放弃，新会话有它自己的访问）；
     * 3. 宿主有权威证据时，必须已经提交到这个会话（host.sessionId === sessionId）。未提交时
     *    绝不发请求——那正是会落到旧 binding 被静默丢弃的情况——只做有限次「等宿主提交」重试；
     * 4. 这个会话的 Expert Group 页在**任意 pane** 里都还不存在（公开只读 openTabs inventory）。
     *    已存在时绝不发请求（那会在当前 pane 再开一个重复页），但仍按「已打开」结算并排展开。
     * 只有真正通过全部校验的请求才算本次访问的 openState = "opened"；失败不记账为成功，按上限重试。
     */
    const runSurfaceOpen = (sessionId, epoch) => {
      if (disposed) return;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return;
      if (record.openState === "opened") return;
      if (currentSurfaceSessionId() !== sessionId) return;
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        // 宿主 binding 还没提交到目标：有限等待（等通知或短重试），绝不盲目发请求。
        // 预算用尽或排不出重试任务（没有可用调度器）时，这次访问不会再走到 openRightbar，
        // 必须立刻收口抑制句柄，绝不把 observer/内联样式悬在宿主上。
        if (record.readinessRetries < MAX_READINESS_RETRIES
          && scheduleSurfaceOpen(sessionId, epoch, HOST_COMMIT_RETRY_MS) === true) {
          record.readinessRetries += 1;
        } else {
          releaseTransitionRestore(record);
        }
        return;
      }
      if (record.openAttempts >= MAX_SURFACE_OPEN_ATTEMPTS) {
        // 打开次数已用尽：这次访问同样不会再调用 openRightbar，收口未消费的句柄。
        releaseTransitionRestore(record);
        return;
      }
      // 跨 pane 已存在判定（必须在真正发请求之前）：宿主刷新后会从持久化布局恢复**全部 pane**
      // 的 tab，而 active() 只返回当前活跃 pane 的 tab——只看 active() 会得出「页面不存在」，
      // 于是在当前 pane 再开一个重复的 Expert Group 页。公开只读 inventory（openTabs.getSnapshot）
      // 是跨 pane 的权威证据，命中即按「已打开」结算：
      // - 不调用 openSurfaceTab：既不新建重复页，也不把焦点抢到别的 pane 的 tab 上；
      // - 不写 record.commitState = "confirmed"：inventory 只能证明 tab 已提交，不能证明它是
      //   当前活跃 pane 的 active tab；写成 confirmed 会伪造出「已确认 → 明确缺失」的重挂载边沿，
      //   把 rightbarPresented 复位并反复重展开右栏（保持 "unknown" 才与读面证据一致）；
      // - 但照旧消费本次访问（openState = "opened"，与成功路径同一条完成语义）并排程右栏展开，
      //   绝不因为跳过 openTab 就让用户看到「页面明明在、右栏却没打开」。
      // 读面缺失/返回 null/抛错时 hasExistingExpertGroupTab 一律返回 false：完全回退旧语义。
      if (hasExistingExpertGroupTab(sessionId)) {
        record.openState = "opened";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        scheduleCurrentSurfaceExpand();
        return;
      }
      record.openAttempts += 1;
      // 注意：视觉连续性遮罩**不在这里**创建。DSH 原生 session-key 重挂载会在本函数执行之前
      // （openTargets 之后的下一帧里）就把旧 panel 删掉，因此抢拍必须在 openTargets() 里、
      // scheduleSurfaceOpen() 之前完成；这里只复用 record 上已有的句柄，绝不再新 clone。
      // 时序硬约束：Better/native 的 openTab 可能**同步**把右栏面板置为展开（公开属性
      // data-sidebar-right-open + transform 过渡），动画从那一刻就已经开始；而 layout.openRightbar
      // 要等下一轮 deferred 展开体才会被调用。因此抑制必须在这里、在 openSurfaceTab() 之前开始，
      // 并把恢复句柄挂到本次访问记录上，等真正调用 openRightbar 之后交给 scheduleInstantRestore 延迟恢复。
      // 启动条件只看「持久标记」：只要宿主上曾经展示过右栏（含本生命周期内刚成功的那次切换），
      // 之后每次自动打开**另一个 surface** 的 openTab 都可能让这个 surface 的 panel 进入 expanded
      // （data-sidebar-right-open → transform: none + 过渡），动画从那一刻开始，所以必须在 openTab
      // 之前抑制这次提交。rightbarPresented 只决定「要不要调用 layout.openRightbar」，不决定
      // 「要不要抑制 panel 动画」——这正是此前「首次展开后切换 surface 仍会滑入」的漏点。
      // 同一访问已有句柄时绝不覆盖（重复通知、重试都复用同一个句柄）。
      if (rightbarPresentedPersisted && typeof record.transitionRestore !== "function") {
        record.transitionRestore = suppressRightbarTransition();
      }
      const opened = openSurfaceTab(sessionId);
      // 保守提交确认：openTab/openTabIn 是 void（openTabIn 的返回值对未挂载会话也不可信），
      // 只有公开读面确认 expert-group 已成为 active，或宿主根本没有该读面（unknown 兼容路径）
      // 时，才算这次打开真的落地。
      const evidence = opened ? activeTabEvidenceOf(sessionId) : "unknown";
      if (opened && (evidence === "confirmed" || evidence === "unknown")) {
        record.openState = "opened";
        record.commitState = evidence === "confirmed" ? "confirmed" : "unknown";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        // 页面落地后才排程展开（展开永远排在打开之后）。
        scheduleCurrentSurfaceExpand();
        return;
      }
      // 请求已发出但没落地（或调用本身失败）：绝不结算、绝不展开。自动定时重试有独立上限
      // （其余机会留给后续通知），总次数仍受 MAX_SURFACE_OPEN_ATTEMPTS 约束；异常已在
      // openSurfaceTab 内部吞掉，绝不抛给调用方。
      if (evidence === "missing") record.commitState = "missing";
      else if (evidence === "other") record.commitState = "other";
      record.openFailures += 1;
      // 重试预算还够、且重试任务确实排得出去时才算消费一次重试；否则立刻收口抑制句柄
      // （重试用尽 / 调度不可用都意味着这次访问不会再调用 layout.openRightbar），
      // 绝不把 observer 与 transition:none 留给宿主。
      if (record.openRetries < MAX_SURFACE_OPEN_RETRIES
        && record.openAttempts < MAX_SURFACE_OPEN_ATTEMPTS
        && scheduleSurfaceOpen(sessionId, epoch, SURFACE_OPEN_RETRY_MS) === true) {
        record.openRetries += 1;
      } else {
        releaseTransitionRestore(record);
      }
    };

    const openTargets = () => {
      if (disposed) return;
      // 页面打开最终只服务当前可见 surface；后台 root/child 不会被这里打开。旧实现为了
      // 判断「是否有目标」先枚举所有 session 并逐个解析 root，切换会话时形成 O(S²) 主线程工作。
      // current 已经是唯一实际会被打开的目标，直接读取一次即可保留同样的行为。
      const current = currentSurfaceSessionId();
      const targets = current === null ? [] : [current];
      // hydration 尚未产生任何可打开 surface 时，不得提前改写宿主宽度偏好；
      // 等后续会话通知带来目标后，再在真正打开前写入该会话的 20%。
      if (targets.length === 0) {
        // 「没有当前可见 surface」是一次**访问终止边沿**，绝不能直接 return 绕过 beginVisit：
        // 上一个会话可能还留着待执行的 open/expand timer，以及未消费的抑制句柄
        // （MutationObserver + panel/frame 的内联 transition:none），绕过清理就会永久留在宿主上。
        // 这里用 (null, null) 走一次与普通访问完全相同的收尾路径：取消上一个可见会话的遗留 timer，
        // 并收口它记录上的抑制句柄；key 相同（持续无 current）时是幂等空操作。
        beginVisit(null, null);
        // 同时 flush 全局待恢复任务：终止边沿必须立刻把过渡样式交还宿主，不能等 RAF/250ms
        // fallback。普通 child 切换永远走不到这里（current 非空），所以不会误 flush 正常展开的
        // 恢复窗口。
        flushInstantRestore();
        // 没有可服务的 surface 就没有 Expert Group 页：手柄锁必须跟着交还宿主（这里 current
        // 为 null，重估只会解锁，不会读任何宿主读面）。
        requestRightbarDragSync();
        return;
      }
      if (better) {
        let enabled = true;
        try { enabled = typeof better.isTabEnabled !== "function" || better.isTabEnabled("expert-group") !== false; } catch { enabled = false; }
        if (!enabled || typeof better.openTab !== "function") {
          // Better 被用户禁用（expert-group tab 关掉）或宿主没有 openTab：这是**本次访问的终止边沿**，
          // 不是「什么都没发生」。仍要结束当前访问：取消该会话遗留的 open/expand timer 并收口
          // 未消费的抑制句柄；但绝不写入右栏宽度、不打开/展开右栏（禁用语义与用户右栏状态都不受影响）。
          // 用 (current, null) 作为终止标记：之后 Better 恢复可用时 visit key 会再次变化，
          // 自然开启新访问继续（不会因为终止过就永久停摆）。
          beginVisit(current, null);
          // 同样是终止边沿：立刻 flush 全局待恢复任务（上一次成功展开排下的 RAF/fallback），
          // 不能等到延迟恢复才把 transition:none 交还宿主。
          flushInstantRestore();
          // 插件这次不会打开任何页面：手柄锁按宿主当前的活跃 tab 重估（页面确实还是
          // Expert Group 时保持锁定，用户切到别的页时立刻交还宿主）。
          requestRightbarDragSync();
          return;
        }
      }
      // 宽度写入先于页面打开：Better 被禁用时上面已 return，不会在「DEG 什么都不开」的
      // 情况下改写宿主的宽度偏好；Expert Group 首次展开前仍需先落盘 20%。
      // 当前如果已经是其它右栏页，50% 模式由右栏同步器负责，不能在每次 session 通知时被
      // 这里的「新 surface」分支重新覆盖成 20%。
      // 不在这里提前读取 active()：openTargets 发生在页面提交前，某些宿主的 active() 读面
      // 会影响调度器就绪时序。上一轮同步已经确认的 mode 足以阻止 50% 可调状态被 20%预置覆盖。
      // 跨 pane 已存在其它页时，当前 Expert Group 不能在这里抢先写 20%；同步器会直接
      // 把总右栏初始化到 50%。这里不读 active()，只用 inventory/DOM 的正向存在证据。
      // mode / prepared / active 全部按 sessionId 读取：root-a 的 other / split-pending 绝不是
      // root-b 的现状，不能阻止 root-b 的首次预置。
      const otherPagePresent = hasOtherRightbarPage(current);
      // 只按**本会话**自己的在途事务判定：别的 session 的 split-pending 与 root-b 的首次预置无关。
      const splitPending = rightbarSplitTransactions.has(current);
      const expertPageCanOwnWidth = splitPending !== true
        && widthModeOf(current) !== "other" && otherPagePresent !== true;
      const widthSurfaceChanged = rightbarWidthSurfaceSessionId !== current;
      const shouldPrepareWidth = expertPageCanOwnWidth && (widthSurfaceChanged
        || isWidthActive(current)
        || !rightbarWidths.has(current));
      if (shouldPrepareWidth && applyRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, widthSurfaceChanged)) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        // 只有本次确实写入才标记 prepared；把 Map 里的旧目标当作“刚写过”会漏掉
        // 「其它分页改宽 → 返回 Expert Group」这条必须强制恢复 20% 的进入边沿。
        setWidthPrepared(current, true);
      }
      // 宿主真正承载右栏的会话（Better 证据优先）；两者都没读到时按 current 兜底，
      // 但「有 API 却读不到活跃会话」会被记成 null，也就是「尚未提交」，只等通知/有限重试。
      const host = readHostActiveSurface();
      const observedActive = host.available ? host.sessionId : current;
      // 同一 sessionId 的 surface 重挂载：宿主把某个此前已确认 expert-group 的目标变成
      // 「明确没有 active tab」（seat 卸载 / 布局被重置）时，开一次新的访问代次重新确保。
      // 只在「已确认 → 明确缺失」这条边沿触发：
      // - 持续缺失不会重复触发（重置后 commitState 回到 unknown）；
      // - active 是别的 kind（用户手动切走 tab）不算重挂载，也不在普通通知里抢回用户 tab；
      // - 读面缺失或抛错时是 unknown，不做任何推断（旧 native / 旧 Better 语义不变）。
      if (current !== null) {
        const previousRecord = surfaceRecords.get(current);
        if (previousRecord !== undefined
          && previousRecord.commitState === "confirmed"
          && activeTabEvidenceOf(current) === "missing") {
          currentRemountSerial += 1;
          // 宿主明确卸载/关掉了这个 surface：右栏这次展示生命周期结束，下一次访问允许重新展开
          // 一次（这也是用户手动关闭右栏后唯一的重开路径）。
          rightbarPresented = false;
          // 该 session 在旧访问里可能还排着一个尚未执行的展开 timer：必须在复位处就地取消，
          // 不依赖随后 beginVisit 的代次变化兜底（那条路径靠「serial 变化必然改 key」这一隐性
          // 顺序耦合；一旦这里的复位与 beginVisit 之间插入别的分支、或那道取消被重排，
          // 旧 timer 就会占着 rightbarExpandTimers 的槽位，新访问的 scheduleRightbarExpand
          // 因「该 session 已有待执行 timer」提前返回 false，重挂载后就再也调不到
          // layout.openRightbar）。取消本身是幂等的：没有待执行 timer 时是无操作。
          cancelRightbarExpand(current);
          // 展开失败预算同样只属于「一次展示生命周期」：必须一起复位，否则旧生命周期里已经
          // 失败到 RIGHTBAR_EXPAND_MAX_ATTEMPTS 的 surface 在新生命周期里永远不会再尝试展开
          // （失败计数绝不能被继承到新生命周期）。
          rightbarExpandFailures.clear();
        }
      }
      // 访问代次：宿主活跃 surface、当前可见会话或重挂载序号变化 = 一次新访问（重复通知不改变
      // 代次，因此不会重置本次访问的打开/展开预算）。
      const epoch = beginVisit(current, observedActive);
      if (current !== null) {
        const record = beginVisitFor(current, epoch);
        // 视觉连续性遮罩（不是动画抑制）：真实时序是 openTargets(current=child) → 旧 panel removed
        // → 新 panel added(collapsed) → runSurfaceOpen → 新 panel open。也就是说旧 panel 在
        // scheduleSurfaceOpen() 的 deferred 打开轮之前就已经被 DSH 的 session-key 重挂载删掉了，
        // 等到 runSurfaceOpen 再 clone 就太晚（旧节点已不存在）。因此必须在这里、在旧 panel 仍然
        // 存在的那一刻抢拍，正好覆盖 openTargets → panel removed 的窗口。
        // 只对「后续 surface 切换」启用：rightbarPresented 表示本生命周期已经展示过右栏，
        // rightbarPresentedPersisted 表示宿主上确实呈现过（含本生命周期内刚成功的那次）。
        // 首次无持久标记、首次自动打开、用户手动开关都不满足条件，因此不会创建遮罩。
        // 同一访问（同一 epoch 的重复通知）只创建一次：record 上已有句柄时直接复用。
        if (rightbarPresented === true && rightbarPresentedPersisted === true
          && typeof record.continuityRelease !== "function") {
          record.continuityRelease = continuityOverlay.capture();
        }
        // 只为「当前可见会话」的本次访问排队打开：绝不预发后台目标的请求（宿主对未挂载会话
        // 的 scoped open 会静默 no-op，却被当成已完成，于是目标被永久跳过）。
        scheduleSurfaceOpen(current, epoch, SURFACE_OPEN_DELAY_MS);
      }
      // 展开同样只排队（defer 到宿主提交之后），并且要求本次访问的页面已经落地。
      scheduleCurrentSurfaceExpand();
      // 最后按宿主当前提交的活跃 tab 重估手柄锁：这条通知路径覆盖会话切换与 Better 设置变化；
      // 页面还没落地时证据是 missing/unknown —— missing 会解锁，unknown 保持现状而不误锁别页。
      // 刻意排在这里（而不是函数开头）：宿主读面的调用顺序与打开流程保持原样，绝不提前读面。
      requestRightbarDragSync();
    };
    /**
     * 右栏拖拽手柄锁的重估实现（在 install 末尾接线，早于 subscribeSessions 的首次通知）。
     *
     * 判定只用宿主公开读面：**当前可见会话**的活跃 tab 必须是 Expert Group。
     * - "confirmed"：锁住 [data-side=rightbar]，用户在这一页上拖不动右栏；
     * - "other" / "missing"：用户在别的右侧分页或没有活跃 tab → 立刻解锁并还原样式；
     * - "unknown"（旧宿主没有 active() 读面等）：无法证明当前页就是 Expert Group，
     *   按兼容处理**不解锁也不加锁**——保持上一次已确认的状态，绝不误伤其它页面。
     *
     * 只用 currentSurfaceSessionId() 解析出的当前会话：后台 root/child 的活跃 tab 与用户
     * 眼前这一页无关，拿它决定手柄锁会锁错页面。
     */
    rightbarDragSyncImpl = () => {
      // 分栏配比与手柄锁共用这条同步链路（面板 observer / 2.5 秒轮询 / visibilitychange 与
      // sessions 通知都会走到这里），因此宿主把第二个 pane 渲染出来、或用户把子代理 pane 关掉
      // 之后，配比会在同一轮里被补上或还原，不为它另挂 observer、也不读取任何额外宿主状态。
      // 刻意排在下面的 early return 之前：这些分支全都不代表「pane 组成没变」。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响宽度与手柄的判定。 */ }
      const current = currentSurfaceSessionId();
      if (current === null) {
        // 没有任何可见 surface：所有在途事务都不可能再提交，逐条收口（每条只清理自己所属会话的
        // transient 记账）；统一回滚失败由后续同步重试。
        cancelAllSidebarSplits("session-missing");
        // 没有可见 surface：归属会话的 transient 记账一并失效（它描述的是「宿主那份宽度属于
        // 该会话」时的状态，不能留给下一个会话当现状）。per-session 的目标值不受影响，该会话
        // 下次被激活时会按自己的目标重估。
        clearRightbarWidthMarks(rightbarWidthSurfaceSessionId);
        rightbarDragLock.setLocked(false);
        return;
      }
      // 可见 surface 已切到**另一会话**：别会话的在途事务（可能有多个）已经不可能由用户继续完成，
      // 只收口它们本身（deadline + 各自的 transient 记账）——绝不回滚宽度、绝不改写当前会话的
      // active/prepared/mode，也不按旧会话去锁手柄；宿主那份全局宽度交给下面这轮针对 current 的
      // 同步自行判定 20%/50%。本会话自己的事务不进这个循环，因此不会被别的会话的同步收口。
      for (const [sessionId, transaction] of [...rightbarSplitTransactions]) {
        if (sessionId === current) continue;
        try { cancelSidebarSplit(transaction.token, { reason: "session-switched" }); } catch { /* 后续同步仍会重估。 */ }
      }
      if (rightbarSplitTransactions.has(current)) {
        // split → openTabs/DOM 提交期间保持 50% 且不锁手柄；guide-only 不足以结算。
        // 只对本会话成立：别的会话的在途事务不阻塞本会话的宽度/手柄判定。
        rightbarDragLock.setLocked(false);
        return;
      }
      const activeEvidence = activeTabEvidenceOf(current);
      let evidence = rightbarCompositionEvidenceOf(current, activeEvidence);
      if (evidence === "unknown" && activeEvidence === "confirmed" && compositionReadFacesUnavailable()) {
        // 旧宿主没有 inventory/DOM 组合读面时，active() 仍是宽度模式与手柄锁的唯一兼容证据。
        // 注意：这条恢复分支只服务宽度/手柄模式；split 事务入口另有更窄的局部例外
        // （isActiveOnlySplitCompatible），那个例外必须单独判定，绝不与这里共用 fail-open。
        evidence = "confirmed";
      }
      if (evidence === "unknown") {
        // 组成不可判定 → 绝不改手柄锁、也绝不臆测模式（fail-closed 语义不变）；但本会话
        // **已经接管过**的宽度模式与组成读面无关，视口变了（或宿主重启后夺回了那份 px）就必须按
        // 同一比例重算，否则窗口最大化后宿主会一直保留旧视口下的 px 偏好（见 recomputeOwnedWidth）。
        recomputeOwnedWidth(current);
        return;
      }
      if (evidence === "confirmed") {
        // openTargets 已在同一同步栈为这个 surface 成功预置过 20% 时，只消费 prepared 标记；
        // 否则这是从其它可调分页重新进入 Expert Group，必须强制恢复 20%。只有宽度已经成功
        // 落到宿主（本轮 prepared 或此前 active）才允许提交 expert 模式并锁手柄。
        // prepared / active 只按当前 sessionId 读取：别的会话的记账绝不参与判定。
        const prepared = isWidthPrepared(current);
        const alreadyActive = isWidthActive(current);
        let widthReady = prepared || alreadyActive;
        if (!widthReady) {
          // 归属由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
          widthReady = applyRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, true);
        } else {
          const viewportChanged = rightbarWidthViewportChanged(current) === true;
          // 一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
          const ownership = rightbarOwnershipOf(current);
          // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
          settleRightbarRecovery(current, ownership);
          const hostReclaimed = ownership !== null && ownership.differs === true;
          if (viewportChanged || hostReclaimed) {
            // 两条重新写入边沿，缺一不可：
            // 1. 窗口最大化 / 全屏 / 拖拽改变了视口：20% 是**视口比例**，必须按新视口重新换算并写入，
            //    否则右栏会一直停在最大化之前那份旧像素宽度上（1600 写 320，3200 仍是 320）；
            // 2. **宿主夺回了那份 px**：DSH 重启后宿主从持久化布局恢复它自己那份旧值，而这份恢复
            //    晚于插件的首次写入（视口一直没变）。Expert Group 页的手柄被插件锁住、20% 又是插件
            //    独占比例，因此「面板宽度不再等于插件 target」就是宿主夺回所有权的可验证证据，必须
            //    把 20% 重新写回去，否则用户看到的是「重启后右栏从 640 缩到 320」。
            // 两条判据都为假时一个字节都不写：同一视口的重复通知仍然保持原有去重语义。
            //
            // 写入许可与 recomputeOwnedWidth（unknown 分支）**共用**同一份有界预算：视口变化不再是
            // 绕过预算的独立边沿——取整后仍是同一个 target 的视口变化（3200 → 3201 → 3202 都是 640）
            // 不是新的一次 mismatch 事件；只有预期 target 真的改变才重新获得预算。宿主持续 clamp 或
            // React 延迟提交时「实际宽度 != target」会一直为真，否则就会与宿主的 clamp 无限拉锯。
            //
            // 这条边沿同样要过证据关：面板宽度读不出来（ownership 为 null）时 recoverRightbarWidth
            // 直接 fail-closed——即使视口真的变了，这里也一个字节都不写（读面不可用期间没有任何证据
            // 说明面板宽度偏离了 target，写下去就是无据改写宿主那份**全局**宽度偏好）。
            recoverRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, ownership);
          }
        }
        setWidthPrepared(current, false);
        setWidthActive(current, widthReady);
        setWidthMode(current, widthReady ? "expert" : null);
        rightbarDragLock.setLocked(widthReady);
        return;
      }
      if (evidence === "missing") {
        // 没有 active tab 不等于存在其它页：清理当前会话已确认的模式并交还手柄，但不猜测性写入 50%。
        clearRightbarWidthMarks(current);
        rightbarDragLock.setLocked(false);
        return;
      }
      // 第一次确认任一 pane 存在其它页时把总右栏预置到 50%；随后只交还手柄，用户拖动出的
      // 宽度由宿主持有。重复通知不会重写 50%（只按当前会话的 other 模式去重），宽度桥接失败
      // 则保持模式未提交，便于以后重试。
      const otherModeMissing = widthModeOf(current) !== "other";
      // 「首次确认其它页」这条边沿无条件预置 50%；视口变化触发的重算则**必须先证明宿主宽度所有权**
      // （面板实际宽度仍等于插件上次写入的 target）。50% 是可调状态，用户在其它右侧分页上拖出的
      // 宽度由宿主持有，仅凭「视口变了」就重算会直接覆盖用户的拖拽结果——这与 unknown 分支里的
      // 同一判据（见 recomputeOwnedWidth）保持完全一致的口径。
      const otherNeedsRecompute = otherModeMissing
        || (rightbarWidthViewportChanged(current) && hostWidthMatchesPluginTarget(current));
      if (otherNeedsRecompute) {
        // 写入失败时只在「首次确认其它页」这条边沿把模式置回未提交，视口重算失败不得抹掉
        // 已经确认的 other 模式。
        if (applyRightbarWidth(current, OTHER_RIGHTBAR_WIDTH_RATIO, true)) {
          setWidthMode(current, "other");
        } else if (otherModeMissing) {
          setWidthMode(current, null);
        }
      }
      setWidthPrepared(current, false);
      setWidthActive(current, false);
      rightbarDragLock.setLocked(false);
    };

    /**
     * 当前 surface 会话 id（由 currentSessionIdOf 兼容解析），不解析成 root。
     *
     * global `sidebarRight.openTab(kind, options)` 没有会话参数：它只会画在「已挂载
     * 会话」上，也就是当前 surface。当前视图可能正是一个 child 子代理会话，此时它的 root
     * 反而是「非当前目标」——用 global 去开它会画到 child 的 surface 上，也会错误地把该
     * root 记成已打开。因此这里返回原始 current，只允许与它完全相同的目标借用 global
     * 接口；解析不出当前会话时返回 null，任何目标都不算当前 surface，全部改走按会话定位。
     */
    const currentSurfaceSessionId = () => currentSessionIdOf(listSnapshot({ ...config, sessions }, ctx));
    /**
     * 打开某个 surface 会话的原生 Expert Group 页面；返回 false 表示当前 DSH 无法按该
     * 会话定位页面（保持未打开状态，由后续会话通知重试）。
     *
     * 顺序固定：
     * 1. 按会话解析出的 session-scoped `sidebarRight.openTab(kind, options)`——公开
     *    接口，作用域实例把该 surface 会话带进打开请求，是唯一能服务任意 surface 的
     *    正规路径（root 与 child 同样适用）；
     * 2. 根级 `sidebarRight.openTab(kind, options)`——同一公开接口，但作用在已挂载
     *    会话上，所以**只有与当前 surface 完全相同的目标**才允许调用；用它去开别的
     *    surface 会把页面画到错误的会话上，也会错误地把那些目标当成已打开；
     * 3. 旧 `openTabIn(sessionId, kind, options)`——它**不属于** ISidebarRight，只是
     *    Tab domain 的按会话内部路径，是旧 DSH 里唯一能按任意会话定位的兼容回退。
     */
    const openNativeTab = (target) => {
      const scopedSidebar = nativeSidebarFor(target);
      if (typeof scopedSidebar?.openTab === "function") {
        scopedSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (target === currentSurfaceSessionId() && typeof nativeSidebar?.openTab === "function") {
        nativeSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (typeof nativeSidebar?.openTabIn === "function") {
        nativeSidebar.openTabIn(target, "expert-group", { revealIfOpened: true });
        return true;
      }
      return false;
    };
    /**
     * split 入口的**窄口径 active-only 兼容例外**（本文件唯一一处；rightbarCompositionEvidenceOf
     * 的结论本身不变）。
     *
     * 为什么需要它：真实 DSH 重启后首次进入 Expert Group 页时，宿主只提供 active()——
     * sidebarRight.openTabs 这个公开 inventory 与 dockkit 的右栏 DOM 读面都还不存在（或读不到）。
     * rightbarCompositionEvidenceOf 对这种 active-only 形状保守返回 "unknown"，而 beginSidebarSplit
     * 原本把 unknown 当 fail-closed，于是行尾橙色 >> 的点击在调用 split()/openResource() 之前就
     * 静默中止：宿主上什么都没发生，用户看到的就是「点了没反应」。
     *
     * 为什么只在这里放开：这条例外只作用于「会创建新 pane」的 split 入口，并且要求三个条件同时
     * 成立，缺一不可：
     * 1. active() 明确就是 Expert Group（other/missing/unknown 一律不放行，绝不放开错误状态）；
     * 2. 目标就是当前可见 surface（否则新 pane 会落到后台会话的布局上）；
     * 3. openTabs inventory 与右栏 DOM **两个组合读面都不可用**（任意一面返回非 null 就说明宿主
     *    能给出真实组成证据，此时必须回到 fail-closed，由 rightbarCompositionEvidenceOf 说话）。
     * 读面不可用（null）本身不代表「没有其它页」，只代表宿主没有这个读面；在这种宿主上 active()
     * 就是唯一的公开组成证据，且既有宽度策略早已按同口径采信它。新宿主只要有 inventory 或 DOM，
     * 条件 3 立刻不成立，行为与修复前完全一致。
     *
     * 边界：只放宽「是否开始本次事务」。事务内部的临时 50% → split → paneId → openResource
     * （preferNewPane:false）→ 目标 tab 的 inventory+DOM 提交证据 → 15 秒 deadline → 取消回滚
     * 全部逻辑逐字不变；读面一直不可用时同样由 deadline 收口回 20%。
     */
    const isActiveOnlySplitCompatible = (sessionId, activeEvidence) => {
      if (activeEvidence !== "confirmed") return false;
      try { if (currentSurfaceSessionId() !== sessionId) return false; } catch { return false; }
      return compositionReadFacesUnavailable();
    };

    /**
     * 首次从 Expert Group-only pane 分栏的协调器。
     *
     * split() 在右栏仅 20% 时可能返回 undefined；事务在调用前强制写入 50%，暂时交还拖拽手柄，
     * 并把 pane、openResource、openTabs 与 DOM 证据拆成几个阶段。只有目标 subagentchat tab
     * 已经位于 split 返回的 pane 才提交 other 模式；失败时若只留下 guide pane，保留 50% 供用户调整。
     * 入口的 composition 判定见 isActiveOnlySplitCompatible：它只放宽「是否开始本次事务」，
     * 事务本身（paneId 回执、preferNewPane:false、提交证据、deadline、取消回滚）逐字不变。
     */
    const beginSidebarSplit = (details) => {
      if (disposed) return { busy: true };
      const input = details !== null && typeof details === "object" ? details : {};
      const sessionId = text(input.sessionId, null);
      if (sessionId === null || currentSurfaceSessionId() !== sessionId) return null;
      // 防重入只针对**同一个 session**：本会话已有在途事务时拒绝第二次 split，绝不产生竞争 pane；
      // 别的 session 的在途事务与本次请求无关，不得把点击挡成 busy（一个卡住的会话不再冻结全部会话）。
      if (rightbarSplitTransactions.has(sessionId)) return { busy: true };
      // split 只允许从已确认的 Expert Group-only composition 开始。active() 缺失、当前
      // 已是其它页或 openTabs/DOM 给出其它 pane 证据时都 fail-closed，避免把新 pane
      // 叠到一个已经可调的用户布局上；唯一例外是上面那个窄口径的 active-only 兼容分支。
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition !== "confirmed" && isActiveOnlySplitCompatible(sessionId, activeEvidence) !== true) return null;
      const prepared = applyRightbarWidth(sessionId, OTHER_RIGHTBAR_WIDTH_RATIO, true);
      if (prepared !== true) return null;
      const token = {};
      const transaction = {
        token,
        sessionId,
        rootSessionId: text(input.rootSessionId, null),
        key: text(input.key, null),
        resourceAddress: text(input.resourceAddress, null),
        paneId: null,
        resourceIssued: false,
        // 只捕获**本会话**的旧模式/活跃记账：取消时要还原的也是这个会话自己的状态，
        // 别的会话的记账既不是它的前态、也不能被它写回去。
        previousMode: widthModeOf(sessionId),
        previousActive: isWidthActive(sessionId),
        deadlineTimer: null,
      };
      // 先入表再写宽度：deadline / commit / cancel 都按这张表反查，表里没有的事务一律不再被结算。
      rightbarSplitTransactions.set(sessionId, transaction);
      // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
      clearRightbarWidthMarks(sessionId);
      setWidthMode(sessionId, "split-pending");
      try { rightbarDragLock.setLocked(false); } catch { /* 临时解锁失败不阻断公开 split；同步会继续收口。 */ }
      try {
        transaction.deadlineTimer = globalThis.setTimeout(() => {
          // 迟到的 deadline 只收口**仍然在途的自己那一条**：已被 commit/cancel 收口的 token 查不到
          // 事务，什么都不做，绝不误伤同会话后来居上的新事务或别的会话。
          if (transactionOf(token) !== null) {
            try { cancelSidebarSplit(token, { reason: "deadline" }); } catch { /* deadline 仍须保持有界。 */ }
          }
        }, SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS);
      } catch {
        // 宿主若没有可用的 timer，不能留下永久 50%/解锁状态；直接走同一取消路径。
        cancelSidebarSplit(token, { reason: "deadline-unavailable" });
        return null;
      }
      return { token };
    };

    const markSidebarSplitPane = (token, paneId) => {
      const transaction = transactionOf(token);
      if (transaction === null || typeof paneId !== "string" || paneId.trim() === "") return false;
      transaction.paneId = paneId;
      return true;
    };

    const markSidebarSplitOpen = (token) => {
      const transaction = transactionOf(token);
      if (transaction === null || transaction.paneId === null) return false;
      transaction.resourceIssued = true;
      return true;
    };

    const commitSidebarSplit = (token, evidence) => {
      const transaction = transactionOf(token);
      const observed = evidence !== null && typeof evidence === "object" ? evidence : {};
      if (transaction === null
        || transaction.resourceIssued !== true
        || transaction.paneId === null
        || text(observed.paneId, null) !== transaction.paneId
        || text(observed.tabId, null) === null) return false;
      clearSidebarSplitDeadline(transaction);
      releaseSidebarSplitTransaction(transaction);
      // 迟到提交边界：只有事务所属会话**仍是当前可见 surface** 时，才允许把宿主那份全局宽度
      // 的归属迁移到它名下。用户已经切到别的会话时只收口本事务自己的 transient 记账——
      // 绝不动当前会话的宽度归属、模式、手柄，否则一个后台面板的迟到 observer 回调就会
      // 把用户眼前的会话改回旧会话的布局。
      let current = null;
      try { current = currentSurfaceSessionId(); } catch { current = null; }
      if (current !== transaction.sessionId) {
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      // 提交后宿主那份宽度归本会话的 other 组成所有（本轮没有写宽度，因此显式接管归属）。
      claimRightbarWidthOwnership(transaction.sessionId);
      clearRightbarWidthMarks(transaction.sessionId);
      setWidthMode(transaction.sessionId, "other");
      try { rightbarDragLock.setLocked(false); } catch { /* 提交后的手柄必须可调，失败由后续同步重试。 */ }
      return true;
    };

    function cancelSidebarSplit(token, details) {
      const transaction = transactionOf(token);
      if (transaction === null) return false;
      clearSidebarSplitDeadline(transaction);
      // 只移除自己那一条：同会话后来居上的新事务、以及别的会话的在途事务都不受影响。
      releaseSidebarSplitTransaction(transaction);
      const current = currentSurfaceSessionId();
      if (current !== transaction.sessionId) {
        if (current === null) {
          // 终止边沿（没有任何可见 surface 接手）：宿主那份全局宽度只能由这里收口，
          // 否则会长期停留在事务期间的临时 50%。恢复的是旧事务会话自己的 20%。
          const restored = applyRightbarWidth(transaction.sessionId, RIGHTBAR_WIDTH_RATIO, true);
          claimRightbarWidthOwnership(transaction.sessionId);
          setWidthPrepared(transaction.sessionId, restored === true);
          setWidthActive(transaction.sessionId, restored === true);
          setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
          try { rightbarDragLock.setLocked(restored === true); } catch { /* 后续同步重估。 */ }
          return true;
        }
        // 可见 surface 已切到**另一会话**：只清理这个被切走的事务和它自己的 transient 记账，
        // 绝不回滚宽度、绝不改写当前会话的 active/prepared/mode，也不按旧会话去锁手柄——宿主
        // 那份全局宽度交给随后针对 current 的同步自行判定 20%/50%。
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(transaction.sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(transaction.sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition === "other") {
        // split 已留下一个真实的其它 pane（通常是 seeded guide）：保留 50%，继续允许用户调整。
        // 本轮没有写宽度，因此显式接管归属（旧会话的 transient 记账随之失效）。
        claimRightbarWidthOwnership(transaction.sessionId);
        clearRightbarWidthMarks(transaction.sessionId);
        setWidthMode(transaction.sessionId, "other");
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步仍会重估。 */ }
        return true;
      }
      const shouldRestoreExpert = transaction.previousMode === "expert" || composition === "confirmed";
      if (shouldRestoreExpert) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        const restored = applyRightbarWidth(transaction.sessionId, RIGHTBAR_WIDTH_RATIO, true);
        setWidthPrepared(transaction.sessionId, restored === true);
        setWidthActive(transaction.sessionId, restored === true);
        setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
        try { rightbarDragLock.setLocked(restored === true); } catch { /* 后续同步重估。 */ }
      } else {
        // 还原的只是本会话自己的前态（别的会话的记账与它无关）。
        setWidthPrepared(transaction.sessionId, false);
        setWidthActive(transaction.sessionId, transaction.previousActive === true);
        setWidthMode(transaction.sessionId, transaction.previousMode === "other" ? "other" : null);
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步重估。 */ }
      }
      return true;
    }

    // 面板只多拿这几个事务注入点：其余 config 字段逐项不变；没有 install coordinator 的
    // 直接 createExpertGroupPanel 测试/宿主仍沿用旧的 split + openResource 兼容路径。
    const panel = createExpertGroupPanel({
      ...config,
      syncRightbarDragLock: requestRightbarDragSync,
      releaseRightbarDragLock,
      beginSidebarSplit,
      markSidebarSplitPane,
      markSidebarSplitOpen,
      commitSidebarSplit,
      cancelSidebarSplit,
    });

    const unsubscribe = subscribeSessions({ ...config, sessions }, ctx, openTargets);
    disposers.push(typeof unsubscribe === "function" ? unsubscribe : () => {});

    if (better) {
      if (typeof better.registerTab === "function") {
        const release = better.registerTab({
          id: "expert-group",
          title: "expert group",
          single: true,
          component: panel,
          // Better 的 tab 图标契约是「size → React 元素」的函数（宿主只把尺寸传进来，
          // 渲染时机与容器由它决定），因此这里传的是工厂而不是元素。缺 react 时整条
          // icon 字段都不写：宿主照常渲染一个无图标的 tab，注册契约的其余字段不变。
          ...(brandIcon === null ? {} : { icon: (size) => brandReact.createElement(brandIcon, { size }) }),
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof better.subscribeState === "function") {
        try {
          const unsubscribeState = better.subscribeState(openTargets);
          if (typeof unsubscribeState === "function") disposers.push(unsubscribeState);
        } catch { /* 旧版 Better Sidebar 没有设置订阅时仍可初次打开。 */ }
      }
      openTargets();
    } else {
      if (typeof tabs?.register === "function") {
        const release = tabs.register({
          id: "dsh-expert-group",
          kind: "expert-group",
          // 子代理 tab 成为 active 后仍保留面板 body，observer/轮询才能继续完成同 pane 的 float 回退。
          keepMounted: true,
          title: () => "expert group",
          guide: [{
            order: 40,
            title: () => "expert group",
            description: () => "查看当前会话的专家任务树",
            // 原生 guide 卡片的图标契约与 Better 相反：宿主以**组件**形式渲染它
            // （`<Icon size={22|26} />`），因此传组件本身，不预构造元素。
            // 缺 react 时同样整条不写，宿主退回到自己的立方体占位。
            ...(brandIcon === null ? {} : { icon: brandIcon }),
          }],
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof slots?.register === "function") {
        const release = slots.register({ name: "sidebar.right.pane.tab", key: "dsh-expert-group" }, panel);
        if (typeof release === "function") disposers.push(release);
      }
      openTargets();
    }
    /**
     * 视口尺寸变化（窗口最大化 / 全屏 / 拖拽窗口边缘 / 旋转屏幕）后重新换算右栏宽度。
     *
     * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store
     * 的是像素值。没有这条边沿，窗口最大化后宿主会一直沿用最大化之前那份旧像素宽度，比例不再
     * 成立（1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640）。
     *
     * 四条约束：
     * - 只读公开的 window 事件，且全程按**可选 API** 处理：没有 window、没有 addEventListener、
     *   代理读取抛错时静默降级为「只靠既有 observer + 2.5 秒轮询兜底」——那条链路同样会靠
     *   视口记账发现变化并补写（见 rightbarWidthViewportChanged），因此老宿主不会失效；
     * - **add 与 remove 必须同时存在**才注册：宿主只有 addEventListener 时（旧 WebView、被冻结
     *   的事件面），注册会成功而 dispose 的注销永远失败，那次 install 的闭包就被永久留在宿主
     *   window 上——每装一次泄漏一个，卸载后仍会被 resize 事件唤醒。这种宿主整条放弃快路径，
     *   同样退回上面那条 observer + 2.5 秒轮询兜底，功能不缺失；
     * - 监听在 install 注册、dispose 移除（走统一的 disposers），绝不在宿主上留下长期监听；
     * - 高频 resize 只在**视口宽度真的变了**时才请求同步：同一宽度的连发事件直接短路，既不做
     *   无谓的组成读面求值，也让行为保持确定性（同步栈内立即生效，不需要推进任何定时器）。
     */
    let lastObservedViewportWidth = viewportWidthOf();
    const onViewportResize = () => {
      if (disposed) return;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return;
      if (lastObservedViewportWidth === viewportWidth) return;
      lastObservedViewportWidth = viewportWidth;
      // 复用既有的宽度/手柄/配比同步链路：不新开一条并行路径，也不直接在这里写宽度。
      requestRightbarDragSync();
    };
    try {
      const viewportTarget = globalThis.window ?? null;
      // 注册条件必须**同时**要求 add 与 remove：宿主只有 addEventListener 时注册会成功、
      // dispose 的注销却永远失败，闭包被永久留在宿主 window 上（每次安装泄漏一个，且卸载后
      // 仍会被 resize 事件唤醒）。宁可少一条快路径，也绝不在宿主上留下摘不掉的监听——
      // 缺少任一 API 时完全依赖既有的 observer + 2.5 秒轮询兜底，它们同样按视口记账补写。
      if (typeof viewportTarget?.addEventListener === "function"
        && typeof viewportTarget?.removeEventListener === "function") {
        viewportTarget.addEventListener("resize", onViewportResize);
        disposers.push(() => {
          try { viewportTarget.removeEventListener("resize", onViewportResize); } catch { /* 注销抛错的宿主只能放弃这条监听。 */ }
        });
      }
    } catch { /* 没有 window 或代理读取抛错：只靠既有 observer 与 2.5 秒轮询兜底。 */ }
    // 到这里 install 函数体里的全部读面（readSurfaceOpenTabs / currentSurfaceSessionId /
    // rightbarDragSyncImpl）都已初始化完成：接线配比读面，后续每一轮同步都能安全求值。
    // 刻意排在 install 函数体的**最后**：任何一次同步（包括下面这次立即求值）都要等这些读面
    // 初始化完成，否则会撞上 const 的 TDZ（异常被同步入口的 try/catch 吞掉，配比就永远写不进去）。
    // 在它之前发生的同步（install 中段那一轮 openTargets）只会拿到 null 读面并安全跳过。
    splitTrackReader = {
      /**
       * 读当前 surface 那条 surface 的分栏容器：session → panel → split 三级读面都必须精确唯一。
       *
       * 返回 { status, container }：
       * - "target"：组成可证明，容器就是本次要施加配比的那一个；
       * - "pending"：结构上仍是两列、列 0 明确是本会话的 Expert Group 页，但列 1 的内容这一轮
       *   读不出来（重启恢复窗口：tab 条 / inventory 归属还没提交）。容器照常返回，调用方据此
       *   保持已写下的配比并短延迟重试——这正是「不闪回宿主默认值」的唯一来源；
       * - null：会话读不出来、inventory 不可用、没有属于本会话的 panel、panel 归属有歧义、
       *   或组成明确不是目标（单列 / 三列 / Expert Group 消失 / 归属冲突）。调用方交还宿主样式。
       *
       * fail-closed 边界不因 pending 放松：pending 只在列 0 的目标身份**已被证明**时才可能返回，
       * 任何未知归属、重复或混合列都仍然走 null（明确非目标），绝不靠猜测进入 pending。
       */
      readTarget(doc) {
        let sessionId = null;
        try { sessionId = currentSurfaceSessionId(); } catch { sessionId = null; }
        if (typeof sessionId !== "string" || sessionId === "") return null;
        // 严格归属：tabId 必须能在当前 session 的 inventory 里对上，绝不用全局 kind 猜测。
        const tabSets = sidebarTabSetsForSession(readSurfaceOpenTabs(), sessionId);
        if (tabSets === null) return null;
        // panel 按 data-sidebar-right-session 精确选择：同名多 panel = 归属不明确，直接放弃。
        const panel = rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
        const container = resolveSplitContainer(panel, tabSets);
        if (container !== null) return { status: "target", container };
        // 两列结构仍在、列 0 仍是 Expert Group 页，只有列 1 的内容读不出来：暂不可读。
        // 单列 / 三列 / 混合列 / 重复列号等形状在这里都拿不到 "unavailable"，一律交还宿主。
        const candidates = splitPairPendingContainers(panel, tabSets);
        if (candidates.length === 1) return { status: "pending", container: candidates[0] };
        return null;
      },
    };
    // install 收尾立即求值一次：中段那一轮 openTargets 触发的同步当时读面还是 null（已跳过），
    // 而右栏 DOM 此刻可能已经是「两列」的形状（刷新恢复的分栏）——不能让 Expert Group 页
    // 停在宿主的等分比例上等下一次 observer/轮询。
    try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响 install。 */ }
    return () => {
      if (disposed) return;
      // 先置位再取消事务：cancel/observer 可能同步重入同步入口，必须让它们看到已销毁状态。
      disposed = true;
      // 逐条收口：每条事务只清理自己所属会话的 transient 记账与 deadline，互不干扰。
      cancelAllSidebarSplits("dispose");
      // 先清掉未执行的所有 deferred 任务（展开 + 补偿打开重试）：卸载后插件不得再碰宿主
      // layout，也不留下泄漏的 timer。
      cancelAllRightbarExpands();
      cancelAllSurfaceOpens();
      // 过渡抑制同样要收尾：取消挂起的延迟恢复、收口所有记录上尚未消费的句柄，并立刻把
      // frame/panel 上的内联样式还原、断开 observer，绝不把「无过渡」这个临时状态留给宿主。
      flushInstantRestore();
      for (const record of surfaceRecords.values()) releaseTransitionRestore(record);
      // 连续性遮罩单例兜底释放（记录级释放已经覆盖它，这里防漏）。
      continuityOverlay.release();
      // 右栏拖拽手柄锁收尾：还原内联样式（锁本身复用面板那条 tab 观察生命周期，不另持观察器），
      // 绝不在宿主上留下「永久不可拖拽」的手柄；宽度记账同样只属于本次安装，一并清空。
      rightbarDragLock.dispose();
      // 首次分栏的列宽配比同样只属于本次安装：把 split 容器的内联 grid-template-columns 还回
      // 宿主原本的值与优先级，并置位 disposed（此后的迟到同步一律不再写入）。
      splitTrackRatio.dispose();
      rightbarWidths.clear();
      // 视口记账与 rightbarWidths 同属本次安装的目标值状态，一并清空（resize 监听已由 disposers 移除）。
      rightbarWidthViewports.clear();
      // per-session 的 transient 记账（模式 / 预置 / 已确认活跃）同样只属于本次安装生命周期。
      rightbarWidthModes.clear();
      rightbarWidthPreparedSessions.clear();
      rightbarWidthActiveSessions.clear();
      // 恢复事件记账（target / 观测到的实际宽度 / 已用预算）同样只属于本次安装生命周期。
      rightbarWidthRecoveries.clear();
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try { disposers[index](); } catch { /* 一个 disposer 失败不能阻止其它所有权释放。 */ }
      }
    };
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

/* source: client-notifications.js */
/**
 * 客户端通知模块（已收缩为占位：客户端不再投递任何通知）。
 *
 * 用户要求：**系统通知是唯一通知界面**——由 Host 在 Windows 右下角弹 Toast（其它应用在前台、
 * DSH 在后台时同样可见），客户端不再承担任何投递职责。因此本模块不再提供：
 *
 * - 页面内卡片/弹窗（历史 ADR 0004 的弹窗桥与其 CSS、aria 契约已整体移除）；
 * - 浏览器通知构造器（客户端不得再次创建系统通知）；
 * - 通知快照的主动轮询（该只读 RPC 仍由 Host 提供，供其它契约与诊断使用，
 *   但客户端不再读取它，也不再据此推导通知）。
 *
 * 文件本身仍留在拼接顺序与 package.json 的 files 白名单里（都由 assembler/发布清单引用），
 * 因此保留"登记一个惰性命名空间"的最小形态：任何仍按旧 Symbol 读取的实现只会拿到一个显式
 * 声明"客户端不投递"的冻结对象，绝不会意外恢复投递能力，也不会在读不到该 Symbol 时抛错。
 *
 * @module dsh-expert-group/client-notifications
 */
(function installClientNotifications(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-notifications");
  // 幂等：同一页面重复求值（打包器重复内联、测试重复 import）不覆盖已有命名空间。
  const existing = global[SYMBOL];
  if (existing !== undefined && existing !== null) return;

  global[SYMBOL] = Object.freeze({
    /** 交付责任归属：只有 Host 会投递（Windows 右下角系统 Toast）。 */
    delivery: "host-system-toast",
    /** 客户端是否具备投递能力：恒为 false（测试与诊断据此断言"客户端不投递"）。 */
    canDeliver: false,
    /** 被移除的投递面清单：读代码的人不必猜哪些能力"本来有"，这里显式列出。 */
    removedCapabilities: Object.freeze([
      "in-page-popup",
      "browser-notification",
      "notification-snapshot-polling",
    ]),
  });
})(globalThis);

/* source: client-model-config.js */
(function installModelConfig(global) {
  "use strict";

  /**
   * 「模型配置」区域的**唯一纯数据流实现**（浏览器安全的 classic IIFE）。
   *
   * 这里只放纯逻辑，不放 React 组件、不发请求、不读写 DOM：
   * - provider 目录装配（`llm/listProviders` × `llm/listConfigurableProviders`）；
   * - credentials 引用推导（与 DSH 内置模型设置页同一条 `<ROUTE>_API_KEY` 规则）；
   * - settings 命名空间路径操作（用户覆盖 materialize / 恢复默认 / 应用草稿）；
   * - 模型目录草稿（模型 ID、显示名、上下文窗口、最大输出 token、输入类型）；
   * - 七个可多选思考档位与 `reasoningEfforts` 的双向映射；
   * - provider 卡片的应用/取消草稿、revision 冲突判定与角色联动守卫。
   *
   * client.js 只从 `globalThis[Symbol.for("dsh-expert-group/client-model-config")]`
   * 取回这份实现并负责渲染，因此同一份判定既被设置页使用，也被 node:test 直接调用，
   * 不存在"测试里一份、界面里另一份"的平行实现。
   */

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（与相邻侧车模块约定一致）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config");

  /**
   * 七个可多选思考档位，顺序固定为 DSH 的 pi-ai 词表顺序
   * （`packages/llm/llm-pi-ai/src/catalog.ts` 的 THINKING_LEVEL_GATE）。
   * 界面永远按这个顺序渲染七个复选框，与当前目录是否声明支持无关。
   */
  const REASONING_EFFORTS = Object.freeze([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);

  /** `off` 档写入的**空字符串值**：DSH 的 schemastery 联合把 `off` 表达为"无 dispatch 值"。 */
  const REASONING_EFFORT_EMPTY = "";

  /** 目录条目的输入类型词表（text / image）。 */
  const INPUT_MODALITIES = Object.freeze(["text", "image"]);

  /** 模型目录未声明输入类型时的回退（与 DSH 的 `defaultInput` 默认值一致）。 */
  const DEFAULT_INPUT_MODALITIES = Object.freeze(["text"]);

  /** 容量字段：K/M 后缀词表与十进制换算（1K = 1000，1M = 1000000）。 */
  const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
  const CAPACITY_SCALE = Object.freeze({ k: 1000, m: 1000000 });

  /** 草稿里必须被显式删除的"空值"：空字符串与 undefined 都不应写进用户层。 */
  function isBlankDraftValue(value) {
    return value === undefined || value === null || value === "";
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * schema 节点判定。
   *
   * schemastery 的节点是**可调用对象**（`typeof node === "function"`），因此不能只接受
   * plain object：`isPlainObject(schemaNode)` 恒为 false，会让协议词表、默认值等
   * schema 派生的读取全部静默退化成空。这里同时接受可调用节点与普通对象字面量，
   * 这样测试里手写的 schema 描述对象也仍然可用。
   */
  function isSchemaNode(value) {
    return isPlainObject(value) || typeof value === "function";
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  /** JSON 等值判定：草稿比较、pathOps 去重与冲突判定共用同一套语义。 */
  function jsonEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (left === undefined || right === undefined) return left === right;
    if (typeof left !== typeof right) return false;
    if (left === null || right === null) return false;
    if (typeof left !== "object") return false;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  /** 纯 JSON 深拷贝：草稿必须与 settings 快照解耦，绝不就地修改宿主对象。 */
  function deepClone(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => deepClone(item));
    const clone = {};
    for (const [key, item] of Object.entries(value)) clone[key] = deepClone(item);
    return clone;
  }

  /**
   * 按路径读取嵌套值；数组下标同样支持。
   * @param {unknown} value
   * @param {readonly string[]} path
   * @returns {unknown}
   */
  function getPath(value, path) {
    let current = value;
    for (const key of Array.isArray(path) ? path : []) {
      if (Array.isArray(current)) {
        current = current[Number(key)];
        continue;
      }
      if (current === null || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  /**
   * 按路径判断键是否存在（`undefined` 值也算存在：这是用户覆盖的判定依据）。
   * @param {unknown} value
   * @param {readonly string[]} path
   * @returns {boolean}
   */
  function hasPath(value, path) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) {
      return isPlainObject(value) && Object.keys(value).length > 0;
    }
    const parent = getPath(value, segments.slice(0, -1));
    const key = segments[segments.length - 1];
    if (Array.isArray(parent)) return Number.isSafeInteger(Number(key)) && Number(key) >= 0 && Number(key) < parent.length;
    if (parent === null || typeof parent !== "object") return false;
    return Object.prototype.hasOwnProperty.call(parent, key);
  }

  /**
   * 不可变写入：复制路径上的每一层容器，绝不修改入参。
   * @param {Record<string, unknown>} root
   * @param {readonly string[]} path
   * @param {unknown} value
   * @returns {Record<string, unknown>}
   */
  function setPath(root, path, value) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) throw new Error("setPath 需要非空路径");
    if (Array.isArray(root)) {
      const next = [...root];
      next[Number(segments[0])] = segments.length === 1 ? value : setPath(next[Number(segments[0])], segments.slice(1), value);
      return next;
    }
    const source = isPlainObject(root) ? root : {};
    const next = { ...source };
    const [head, ...rest] = segments;
    next[head] = rest.length === 0 ? value : setPath(source[head], rest, value);
    return next;
  }

  /**
   * 不可变删除：路径末端的容器类型与原值一致；路径不存在时原样返回。
   * @param {Record<string, unknown>} root
   * @param {readonly string[]} path
   * @returns {Record<string, unknown>}
   */
  function deletePath(root, path) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) return isPlainObject(root) ? {} : root;
    if (!hasPath(root, segments)) return root;
    if (Array.isArray(root)) {
      const next = [...root];
      const [head, ...rest] = segments;
      if (rest.length === 0) next.splice(Number(head), 1);
      else next[Number(head)] = deletePath(next[Number(head)], rest);
      return next;
    }
    const next = { ...root };
    const [head, ...rest] = segments;
    if (rest.length === 0) Reflect.deleteProperty(next, head);
    else next[head] = deletePath(next[head], rest);
    return next;
  }

  function getSubtree(root, path) {
    const value = getPath(root, path);
    return isPlainObject(value) ? value : {};
  }

  /**
   * 从 provider 路由 id 推导凭据引用：与 DSH 内置模型设置页完全同一条规则。
   * @param {string} provider
   * @returns {string}
   */
  function deriveKeyRef(provider) {
    const text = isNonEmptyString(provider) ? provider : "";
    return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
  }

  /** 模型显示名的归一读取：空显示名回退到模型 ID。 */
  function modelDisplayNameOf(model) {
    if (!isPlainObject(model)) return "";
    if (isNonEmptyString(model.name)) return model.name;
    return typeof model.id === "string" ? model.id : "";
  }

  /**
   * 读一条已存储模型条目的输入类型：数组优先，未声明时返回回退值。
   * @param {unknown} model
   * @param {readonly string[]} [fallback]
   * @returns {string[]}
   */
  function modelInputOf(model, fallback) {
    const declared = isPlainObject(model) ? model.input : undefined;
    if (Array.isArray(declared) && declared.length > 0) {
      return declared.filter((value) => typeof value === "string");
    }
    if (Array.isArray(fallback) && fallback.length > 0) return [...fallback];
    return [...DEFAULT_INPUT_MODALITIES];
  }

  /** 一行模型草稿的浅拷贝读取；非对象按空行处理。 */
  function modelRowOf(value) {
    return isPlainObject(value) ? { ...value } : {};
  }

  /** 把任意数组归一为模型草稿数组（逐行浅拷贝，隐藏字段原样保留）。 */
  function modelDraftsOf(value) {
    return Array.isArray(value) ? value.map((entry) => modelRowOf(entry)) : [];
  }

  /** 描述输入类型字段是否存在用户覆盖。 */
  function inputOverrideOf(model) {
    const declared = isPlainObject(model) ? model.input : undefined;
    return Array.isArray(declared) && declared.length > 0;
  }

  /** 思考档位多选集合的空值：七档全不勾选。 */
  function emptyEffortSelection() {
    const selection = {};
    for (const level of REASONING_EFFORTS) selection[level] = false;
    return selection;
  }

  /**
   * 从模型条目的 `reasoningEfforts` 映射恢复勾选状态。
   *
   * 已有条目：只有"键存在且值不是 false"才算勾选（`off` 的空字符串 / null 都是勾选）。
   * 新条目（字段缺失）与显式 `false`：七档全部不勾选。
   * `reasoningEfforts: false` 表示"非推理模型"，不作为任何档位的勾选来源。
   * @param {unknown} model
   * @returns {Record<string, boolean>}
   */
  function effortSelectionFor(model) {
    const selection = emptyEffortSelection();
    if (!isPlainObject(model)) return selection;
    const declared = model.reasoningEfforts;
    if (declared === false || !isPlainObject(declared)) return selection;
    for (const level of REASONING_EFFORTS) {
      if (!Object.prototype.hasOwnProperty.call(declared, level)) continue;
      selection[level] = declared[level] !== false;
    }
    return selection;
  }

  /** 两份勾选状态是否等价（只比较七个可见档位）。 */
  function effortSelectionEqual(left, right) {
    const a = isPlainObject(left) ? left : {};
    const b = isPlainObject(right) ? right : {};
    return REASONING_EFFORTS.every((level) => (a[level] === true) === (b[level] === true));
  }

  /** `reasoningEfforts` 里未被界面展示的键（未知键必须原样保留）。 */
  function unknownEffortKeysOf(declared) {
    if (!isPlainObject(declared)) return [];
    return Object.keys(declared).filter((key) => !REASONING_EFFORTS.includes(key));
  }

  /** 判断一份映射在"七档可见键"之外是否还有内容。 */
  function hasUnknownEffortKeys(declared) {
    return unknownEffortKeysOf(declared).length > 0;
  }

  /** 记录两条模型路径的 diff 行（纯函数，供侧栏/测试断言使用）。 */
  function reasoningDiffLines(before, after) {
    const lines = [];
    const beforePaths = new Map();
    const afterPaths = new Map();
    const collect = (map, rows) => {
      (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        if (!isPlainObject(row) || !isNonEmptyString(row.id)) return;
        map.set(row.id.trim(), { index, efforts: jsonEqual(row.reasoningEfforts, undefined) ? undefined : row.reasoningEfforts });
      });
    };
    collect(beforePaths, before);
    collect(afterPaths, after);
    const ids = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])];
    for (const id of ids) {
      const previous = beforePaths.get(id);
      const next = afterPaths.get(id);
      if (previous === undefined) {
        lines.push({ id, kind: "added", levels: selectedLevelsOf(next?.efforts) });
        continue;
      }
      if (next === undefined) {
        lines.push({ id, kind: "removed", levels: selectedLevelsOf(previous.efforts) });
        continue;
      }
      const beforeLevels = selectedLevelsOf(previous.efforts);
      const afterLevels = selectedLevelsOf(next.efforts);
      const added = afterLevels.filter((level) => !beforeLevels.includes(level));
      const removed = beforeLevels.filter((level) => !afterLevels.includes(level));
      if (added.length > 0 || removed.length > 0) lines.push({ id, kind: "changed", added, removed });
    }
    return lines;
  }

  /** 一份 `reasoningEfforts` 映射当前勾选的档位（用于 diff 展示）。 */
  function selectedLevelsOf(declared) {
    if (!isPlainObject(declared)) return [];
    return REASONING_EFFORTS.filter((level) => Object.prototype.hasOwnProperty.call(declared, level) && declared[level] !== false);
  }

  /**
   * 把勾选状态写回一份 `reasoningEfforts` 映射。
   *
   * - `off` 勾选写空字符串值，其余档位写同名小写字符串；
   * - 只增删七个可见键，未展示的未知键原样保留；
   * - 七档全不勾选且没有未知键时返回 `undefined`（调用方据此删除该字段）。
   *
   * @param {Record<string, boolean>} selection
   * @param {unknown} previous
   * @returns {Record<string, unknown> | undefined}
   */
  function applyEffortSelection(selection, previous) {
    const source = isPlainObject(selection) ? selection : {};
    const next = isPlainObject(previous) ? { ...previous } : {};
    for (const level of REASONING_EFFORTS) {
      if (source[level] === true) next[level] = level === "off" ? REASONING_EFFORT_EMPTY : level;
      else Reflect.deleteProperty(next, level);
    }
    if (Object.keys(next).length === 0) return undefined;
    return next;
  }

  /**
   * 归一一条模型草稿里的 `reasoningEfforts`：
   * 界面写入的键都指向档位名（或 `off` 的空字符串），因此直接复用七档映射规则。
   * @param {Record<string, unknown>} model
   * @returns {Record<string, unknown>}
   */
  function normalizeEffortsEntry(model) {
    const row = modelRowOf(model);
    const declared = row.reasoningEfforts;
    if (!isPlainObject(declared)) {
      if (declared === false) Reflect.deleteProperty(row, "reasoningEfforts");
      return row;
    }
    const selection = {};
    for (const level of REASONING_EFFORTS) {
      selection[level] = Object.prototype.hasOwnProperty.call(declared, level) && declared[level] !== false;
    }
    const next = applyEffortSelection(selection, declared);
    if (next === undefined) Reflect.deleteProperty(row, "reasoningEfforts");
    else row.reasoningEfforts = next;
    return row;
  }

  /** 构建一条新模型草稿：新模型七档全不勾选，输入类型留空（继承目录/默认值）。 */
  function createModelRow(id) {
    return { id: typeof id === "string" ? id : "" };
  }

  /** 读取一行草稿的输入类型勾选（未声明时回退到目录/默认值）。 */
  function inputSelectionFor(model, fallback) {
    return modelInputOf(model, fallback);
  }

  /**
   * 应用一条模型行的编辑。
   *
   * `patch` 里的 `undefined` / `''` / `null` 都表示清空该字段（从用户层删除），
   * 其余字段原样保留，因此隐藏字段与未知键都不会被重建丢失。
   *
   * @param {Record<string, unknown>} model
   * @param {Record<string, unknown>} patch
   * @returns {Record<string, unknown>}
   */
  function patchModelDraft(model, patch) {
    const row = modelRowOf(model);
    const next = { ...row };
    for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
      if (isBlankDraftValue(value)) Reflect.deleteProperty(next, key);
      else next[key] = value;
    }
    return normalizeEffortsEntry(next);
  }

  /**
   * 整表替换一条模型行的 `reasoningEfforts`（卡片草稿路径）。
   * @param {readonly unknown[]} models
   * @param {number} index
   * @param {Record<string, boolean>} selection
   * @returns {Record<string, unknown>[]}
   */
  function setModelEffortSelection(models, index, selection) {
    const rows = modelDraftsOf(models);
    return rows.map((row, at) => {
      if (at !== index) return row;
      const next = { ...row };
      const efforts = applyEffortSelection(selection, row.reasoningEfforts);
      if (efforts === undefined) Reflect.deleteProperty(next, "reasoningEfforts");
      else next.reasoningEfforts = efforts;
      return next;
    });
  }

  /**
   * 整表替换一条模型行的输入类型（卡片草稿路径）。
   * @param {readonly unknown[]} models
   * @param {number} index
   * @param {readonly string[] | undefined} modalities
   * @returns {Record<string, unknown>[]}
   */
  function setModelInputSelection(models, index, modalities) {
    const rows = modelDraftsOf(models);
    return rows.map((row, at) => {
      if (at !== index) return row;
      const next = { ...row };
      const declared = Array.isArray(modalities)
        ? modalities.filter((value) => INPUT_MODALITIES.includes(value))
        : [];
      if (declared.length === 0) Reflect.deleteProperty(next, "input");
      else next.input = declared;
      return next;
    });
  }

  /** 删除一条模型行。 */
  function removeModelRow(models, index) {
    return modelDraftsOf(models).filter((_row, at) => at !== index);
  }

  /** 追加一条空模型行（新模型七档全不勾选）。 */
  function appendModelRow(models, id) {
    return [...modelDraftsOf(models), createModelRow(id)];
  }

  /**
   * 容量字段文本 -> 数值：空文本表示继承（`undefined`），不可读文本为 `NaN`。
   * @param {string} text
   * @returns {number | undefined}
   */
  function parseCapacity(text) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) return undefined;
    const match = CAPACITY_PATTERN.exec(trimmed);
    if (match === null) return Number.NaN;
    const suffix = match[2] === undefined ? undefined : match[2].toLowerCase();
    const scale = suffix === undefined ? 1 : CAPACITY_SCALE[suffix];
    const scaled = Number(match[1]) * scale;
    const rounded = Math.round(scaled);
    return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
  }

  /** 容量数值 -> 最短文本拼写（K/M 后缀，整千整百万才缩写）。 */
  function formatCapacity(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    if (!Number.isInteger(value) || value <= 0) return String(value);
    if (value % CAPACITY_SCALE.m === 0) return String(value / CAPACITY_SCALE.m) + "M";
    if (value % CAPACITY_SCALE.k === 0) return String(value / CAPACITY_SCALE.k) + "K";
    return String(value);
  }

  /**
   * 归一并校验模型草稿数组：schema 之前先拒绝适配器无法表达的行。
   * @param {unknown} value
   * @returns {{ ok: boolean, rows: Record<string, unknown>[], error: string | null }}
   */
  function validateModelRows(value) {
    const rows = modelDraftsOf(value);
    const seen = new Set();
    for (const [index, row] of rows.entries()) {
      const position = index + 1;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (id.length === 0) return { ok: false, rows, error: "第 " + position + " 行：模型 ID 不能为空" };
      if (seen.has(id)) return { ok: false, rows, error: "第 " + position + " 行：模型 ID 重复（" + id + "）" };
      seen.add(id);
      if (row.name !== undefined && (typeof row.name !== "string" || row.name.length === 0)) {
        return { ok: false, rows, error: "第 " + position + " 行：显示名必须是非空文本" };
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        const raw = row[field];
        if (raw === undefined) continue;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
          return {
            ok: false,
            rows,
            error: "第 " + position + " 行：" + (field === "contextWindow" ? "上下文窗口" : "最大输出 token") + "必须是正整数",
          };
        }
      }
      const declared = row.reasoningEfforts;
      if (declared !== undefined && declared !== false && !isPlainObject(declared)) {
        return { ok: false, rows, error: "第 " + position + " 行：思考档位映射必须是对象（或 false）" };
      }
    }
    return { ok: true, rows, error: null };
  }

  /**
   * 归一模型草稿：去掉纯空白字段、把 ID/显示名去首尾空白、重建七档映射。
   * @param {unknown} value
   * @returns {Record<string, unknown>[]}
   */
  function normalizeModelRows(value) {
    return modelDraftsOf(value)
      .map((row) => {
        const next = { ...row };
        if (typeof next.id === "string") next.id = next.id.trim();
        if (typeof next.name === "string") {
          const trimmed = next.name.trim();
          if (trimmed.length === 0) Reflect.deleteProperty(next, "name");
          else next.name = trimmed;
        }
        return normalizeEffortsEntry(next);
      })
      .filter((row) => {
        // 完全空白的行（用户在"添加模型"后没填 ID）不写进用户层。
        const onlyIdentity = Object.keys(row).length <= 1;
        return !(onlyIdentity && (row.id === undefined || row.id === ""));
      });
  }

  /**
   * 计算从 `before` 到 `after` 的最小路径操作序列。
   * 只命名两边观察到的键：只在一侧出现的键产生 set/unset，值相等的键不产生操作。
   *
   * @param {readonly string[]} base
   * @param {unknown} before
   * @param {unknown} after
   * @param {readonly string[]} [allowedKeys]
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function pathOps(base, before, after, allowedKeys) {
    const prefix = Array.isArray(base) ? base : [];
    const previous = isPlainObject(before) ? before : {};
    const next = isPlainObject(after) ? after : {};
    const allowed = Array.isArray(allowedKeys) ? new Set(allowedKeys) : null;
    const ops = [];
    for (const [key, value] of Object.entries(next)) {
      if (allowed !== null && !allowed.has(key)) continue;
      if (jsonEqual(previous[key], value)) continue;
      ops.push({ op: "set", path: [...prefix, key], value: deepClone(value) });
    }
    for (const key of Object.keys(previous)) {
      if (allowed !== null && !allowed.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(next, key)) continue;
      ops.push({ op: "unset", path: [...prefix, key] });
    }
    return ops;
  }

  /** 是否有可提交的路径操作。 */
  function hasOps(ops) {
    return Array.isArray(ops) && ops.length > 0;
  }

  /**
   * namespace revision 冲突判定：提交前复核卡片读到的 revision 是否仍是当前值。
   * @param {number} expectedRevision
   * @param {number} currentRevision
   * @returns {boolean}
   */
  function revisionConflictOf(expectedRevision, currentRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return false;
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) return true;
    return expectedRevision !== currentRevision;
  }

  /**
   * 卡片进入编辑态时固定的基线：草稿基底 + revision 栅栏 + 继承来源。
   * @param {{ revision?: number, user?: unknown, base?: unknown, value?: unknown }} snapshot
   * @param {readonly string[]} path
   * @returns {{ revision: number | null, userSubtree: Record<string, unknown>, effectiveSubtree: Record<string, unknown>, inherited: Record<string, unknown> }}
   */
  function createEditorBaseline(snapshot, path) {
    const source = isPlainObject(snapshot) ? snapshot : {};
    const revision = Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : null;
    const user = source.user;
    const pinned = getPath(source.base, path);
    return {
      revision,
      userSubtree: getSubtree(user, path),
      effectiveSubtree: getSubtree(source.value, path),
      inherited: isPlainObject(pinned) ? deepClone(pinned) : {},
    };
  }

  /** 卡片当前是否持有用户覆盖（`user` 层存在该路径）。 */
   function modelCatalogOverridden(baseline) {
     if (!isPlainObject(baseline) || !isPlainObject(baseline.userSubtree)) return false;
     return Object.prototype.hasOwnProperty.call(baseline.userSubtree, "models")
       && Array.isArray(baseline.userSubtree.models);
   }

   function isOverridden(baseline) {
     if (!isPlainObject(baseline)) return false;
     return Object.keys(baseline.userSubtree ?? {}).length > 0;
   }

  /**
   * 模型目录的显示内容：有用户覆盖时用覆盖，否则用"适配器/组合层默认"的继承值。
   * 继承值优先取组合层（`base`）钉住的行，缺失时回退到已解析生效值里的行。
   *
   * @param {ReturnType<typeof createEditorBaseline>} baseline
   * @returns {{ overridden: boolean, models: Record<string, unknown>[], inherited: Record<string, unknown>[] }}
   */
  function inheritedModelsOf(baseline) {
    const source = isPlainObject(baseline) ? baseline : {};
    const overridden = modelCatalogOverridden(source);
    if (overridden) {
      return { overridden: true, models: modelDraftsOf(source.userSubtree?.models), inherited: [] };
    }
    const baseRows = Array.isArray(source.inherited?.models) ? source.inherited.models : undefined;
    const effectiveRows = Array.isArray(source.effectiveSubtree?.models) ? source.effectiveSubtree.models : [];
    return { overridden: false, models: modelDraftsOf(baseRows ?? effectiveRows), inherited: modelDraftsOf(baseRows ?? effectiveRows) };
  }

  /**
   * 卡片会话在删除用户覆盖后使用的默认模型目录。
   * 用户覆盖存在时不能从 effectiveSubtree 回退，因为 effectiveSubtree 仍包含覆盖本身。
   * @param {ReturnType<typeof createEditorBaseline>} baseline
   * @returns {Record<string, unknown>[]}
   */
  function fallbackModelsOf(baseline) {
    const source = isPlainObject(baseline) ? baseline : {};
    const baseRows = Array.isArray(source.inherited?.models) ? source.inherited.models : undefined;
    if (baseRows !== undefined) return modelDraftsOf(baseRows);
    if (modelCatalogOverridden(source)) return [];
    return modelDraftsOf(source.effectiveSubtree?.models);
  }

  /**
   * 首次编辑时 materialize 用户覆盖：把草稿整体写到用户层（settings.mutate 的 set 操作）。
   * @param {readonly string[]} path
   * @param {readonly unknown[]} models
   * @returns {Array<{ op: "set", path: string[], value: unknown }>}
   */
  function materializeOverrideOps(path, models) {
    return [{
      op: "set",
      path: [...(Array.isArray(path) ? path : []), "models"],
      value: modelDraftsOf(models),
    }];
  }

  /**
   * 恢复默认：删除用户覆盖（settings.mutate 的 unset 操作），继承值随即生效。
   * @param {readonly string[]} path
   * @returns {Array<{ op: "unset", path: string[] }>}
   */
  function restoreDefaultOps(path) {
    return [{ op: "unset", path: [...(Array.isArray(path) ? path : []), "models"] }];
  }

  /**
   * 卡片提交的路径操作：相对进入编辑态时的 user 基线做 diff。
   * 未覆盖 + 草稿没有任何内容时不产生任何操作（不 materialize 空覆盖）。
   *
   * `profilePath` 是 **profile 子树**在命名空间内的路径（整段即 profile 时为空数组），
   * `draft` 是编辑后的 profile 子树（含 `models`、`baseURL`、`apiKeyEnv` 等卡片可见字段）。
   * diff 在 profile 层级进行，因此只命名卡片看到的键，未展示的字段绝不重建或删除。
   *
   * @param {{ profilePath: readonly string[], baseline: unknown, draft: Record<string, unknown>, catalogTouched?: boolean }} options
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
   function modelCatalogOps({ profilePath, baseline, draft, catalogTouched }) {
     const overridden = isOverridden(baseline);
     const rawDraft = isPlainObject(draft) ? draft : {};
     const includeModels = catalogTouched !== false;
     const sourceNext = includeModels
       ? rawDraft
       : (isPlainObject(baseline?.userSubtree) && Object.prototype.hasOwnProperty.call(baseline.userSubtree, "models")
         ? { ...rawDraft, models: deepClone(baseline.userSubtree.models) }
         : deletePath(rawDraft, ["models"]));
     const next = Array.isArray(sourceNext.models) && sourceNext.models.length === 0 && includeModels
       ? deletePath(sourceNext, ["models"])
       : sourceNext;
     // 未覆盖时只允许 materialize 真正有内容的草稿：直接点"应用"不能凭空写一份空 profile。
     if (!overridden && Object.keys(next).length === 0) return [];
     return pathOps(profilePath, overridden ? baseline.userSubtree : undefined, next, EDITABLE_PROFILE_FIELDS);
   }

  /**
   * 相对 *已存储* 用户层的最小子树操作（provider 资料编辑用）：
   * 只命名卡片能看到的字段，未展示的字段绝不重建。
   *
   * @param {unknown} stored - 已存储的用户子树（可能不存在）。
   * @param {Record<string, unknown>} draft - 卡片编辑后的子树。
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function providerSubtreeOps(stored, draft) {
    return pathOps([], stored, draft);
  }

  /**
   * provider 卡片有权编辑的 profile 字段。
   *
   * 只命名卡片看到的字段是刻意的：settings.yaml 里的隐藏高级字段（transport、retryPolicy、
   * compat…）不进入草稿，因此既不会被显示，也不会在提交时被重建或删除（与 DSH 内置模型
   * 设置页"卡片只写自己的字段"同一条原则）。
   */
  const EDITABLE_PROFILE_FIELDS = Object.freeze(["displayName", "apiKeyEnv", "baseURL", "api", "models"]);

  /**
   * 把一份 profile 收敛到卡片有权编辑的字段。`models` 只在确实是数组时保留（空数组表示
   * "已清空目录"，等同恢复默认）。
   *
   * @param {unknown} source
   * @returns {Record<string, unknown>}
   */
  function modelEditableProfileOf(source) {
    if (!isPlainObject(source)) return {};
    const next = {};
    for (const field of EDITABLE_PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
      const value = source[field];
      if (value === undefined || value === null) continue;
      if (field === "models" && !Array.isArray(value)) continue;
      next[field] = deepClone(value);
    }
    return next;
  }

  /**
   * 「写入前 materialize」：把当前生效值（effective value）里卡片能看到的字段导入草稿。
   *
   * 这是"首次编辑才 materialize 用户覆盖"的实现方式：卡片在用户真正编辑时先导入，
   * 提交时再与 **已存储的用户层** diff，因此
   * - 没有用户覆盖时，导入值 + 编辑值就是这份覆盖的全部内容（等价于写入用户层）；
   * - 已有用户覆盖时，只有实际改动才会变成 set，未被改动的字段不会重复写入；
   * - 卡片编辑期间到达的外部提交不会让"已存在的用户覆盖"被误判成删除。
   *
   * @param {unknown} source - 已解析生效值里的 profile 子树（`namespace.value` 的路径值）。
   * @returns {Record<string, unknown>}
   */
  function importNamespace(source) {
    return modelEditableProfileOf(source);
  }

  /**
   * 把一份完整的模型目录草稿换算成提交用的路径操作。
   *
   * @param {readonly string[]} modelsPath - 模型数组在命名空间内的路径。
   * @param {readonly {}[]} models - 归一后的模型目录（空数组表示"沿用适配器默认"）。
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function catalogOpsFor(modelsPath, models) {
    const path = Array.isArray(modelsPath) ? modelsPath : [];
    const rows = modelDraftsOf(models);
    if (rows.length === 0) return [{ op: "unset", path: [...path] }];
    return [{ op: "set", path: [...path], value: rows }];
  }

  /**
   * 把「用户覆盖 materialize / 恢复默认」判定收敛成一次决策，供 UI 与测试共用。
   * @param {{ overridden: boolean, dirty: boolean, models: readonly unknown[] }} input
   * @returns {"reset" | "materialize" | "replace" | "noop"}
   */
  function modelOverrideDecision({ overridden, dirty, models }) {
    if (!dirty) return "noop";
    const empty = modelDraftsOf(models).length === 0;
    if (overridden && empty) return "reset";
    if (!overridden) return "materialize";
    return "replace";
  }

  /** 供 UI 显示的选择：把已存储行的模型选项归一为 `{ id, name }` 列表。 */
  function modelChoicesOf(rows) {
    return modelDraftsOf(rows)
      .filter((row) => isNonEmptyString(row.id))
      .map((row) => ({ id: row.id.trim(), name: modelDisplayNameOf(row) }));
  }

  /** 使目录行按 ID 索引，便于"取模型"时保留用户已调整的容量字段。 */
  function indexModelsById(rows) {
    const index = new Map();
    for (const row of modelDraftsOf(rows)) {
      if (isNonEmptyString(row.id)) index.set(row.id.trim(), row);
    }
    return index;
  }

  /**
   * 采纳端点/目录返回的候选模型：已存在的行（用户调过的数值）优先，其余新增。
   * 新采纳的行七档全不勾选（`effortSelectionFor` 对缺失字段即全不勾选）。
   *
   * @param {readonly unknown[]} rows
   * @param {readonly { id?: unknown, name?: unknown, contextWindow?: unknown, maxTokens?: unknown, inputModalities?: unknown }[]} candidates
   * @returns {Record<string, unknown>[]}
   */
  function adoptModels(rows, candidates) {
    const index = indexModelsById(rows);
    const next = modelDraftsOf(rows).map((row) => {
      const id = isNonEmptyString(row.id) ? row.id.trim() : "";
      return id.length === 0 ? row : index.get(id);
    });
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!isPlainObject(candidate) || !isNonEmptyString(candidate.id)) continue;
      const id = candidate.id.trim();
      if (index.has(id)) continue;
      const row = { id };
      if (isNonEmptyString(candidate.name)) row.name = candidate.name;
      if (typeof candidate.contextWindow === "number") row.contextWindow = candidate.contextWindow;
      if (typeof candidate.maxTokens === "number") row.maxTokens = candidate.maxTokens;
      if (Array.isArray(candidate.inputModalities) && candidate.inputModalities.length > 0) {
        row.input = candidate.inputModalities.filter((value) => typeof value === "string");
      }
      index.set(id, row);
      next.push(row);
    }
    return next;
  }

  /**
   * 合并 provider 目录与已注册路由：声明顺序优先，未声明的活动路由追加在后。
   * @param {readonly { id?: unknown, name?: unknown }[]} registered
   * @param {readonly Record<string, unknown>[]} directory
   * @returns {Record<string, unknown>[]}
   */
  function joinProviderDirectory(registered, directory) {
    const active = new Set();
    for (const provider of Array.isArray(registered) ? registered : []) {
      if (isPlainObject(provider) && isNonEmptyString(provider.id)) active.add(provider.id);
    }
    const declared = new Set();
    const rows = [];
    for (const entry of Array.isArray(directory) ? directory : []) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.provider)) continue;
      declared.add(entry.provider);
      rows.push({
        provider: entry.provider,
        displayName: isNonEmptyString(entry.displayName) ? entry.displayName : entry.provider,
        settingsNs: typeof entry.settingsNs === "string" ? entry.settingsNs : "",
        settingsPath: Array.isArray(entry.settingsPath) ? [...entry.settingsPath] : [],
        active: active.has(entry.provider),
        declared: entry.declared === true,
        error: typeof entry.error === "string" && entry.error.length > 0 ? entry.error : undefined,
      });
    }
    for (const provider of Array.isArray(registered) ? registered : []) {
      if (!isPlainObject(provider) || !isNonEmptyString(provider.id) || declared.has(provider.id)) continue;
      rows.push({
        provider: provider.id,
        displayName: isNonEmptyString(provider.name) ? provider.name : provider.id,
        settingsNs: "",
        settingsPath: [],
        active: true,
        declared: false,
        error: undefined,
      });
    }
    return rows;
  }

  /** provider 卡片是否可编辑（有可写 settings 命名空间与 profile 路径）。 */
  function providerEditable(row, namespace) {
    return isPlainObject(row) && isNonEmptyString(row.settingsNs) && isPlainObject(namespace);
  }

  /** provider 卡片是否可删除（用户层存在 profile）。 */
  function providerRemovable(row, namespace) {
    if (!isPlainObject(row) || !isPlainObject(namespace)) return false;
    if (row.settingsPath.length === 0 && row.settingsNs !== "") {
      // 整段即 profile：用户层存在任意键即视为可删除。
      return hasPath(namespace.user, row.settingsPath);
    }
    return hasPath(namespace.user, row.settingsPath);
  }

  /** 从有效配置与组合层读出 provider 的 profile（草稿基底）。 */
  function providerProfileOf(row, namespace) {
    if (!isPlainObject(row) || !isPlainObject(namespace)) return {};
    return getSubtree(namespace.value, row.settingsPath);
  }

  /** provider profile 的 apiKeyEnv（未声明时为空字符串）。 */
  function apiKeyEnvOf(row, namespace) {
    const profile = providerProfileOf(row, namespace);
    return isNonEmptyString(profile.apiKeyEnv) ? profile.apiKeyEnv : "";
  }

  /** provider 卡片的凭据引用：profile 的 apiKeyEnv 优先，否则用同一条推导规则。 */
  function credentialRefOf(row, namespace) {
    const named = apiKeyEnvOf(row, namespace);
    return named.length > 0 ? named : deriveKeyRef(isPlainObject(row) ? row.provider : "");
  }

  /**
   * 从命名空间自己的 schema 读出可选协议列表（手写 route 的 `api` 字段）。
   *
   * 显式给出非空 `settingsPath` 时按该路径查询（provider 的 profile 基路径不一定是
   * `providers`）；省略或给空数组时按 pi-ai profile 的默认形状 `providers.<route>.api`
   * 查询。`nodeAtPath` 自己会穿过 dict 的 inner 节点，因此这里不需要知道中间层是 dict
   * 还是 object。
   *
   * @param {unknown} root - 已 rehydrate 的 schema 节点。
   * @param {string} provider
   * @param {{ nodeAtPath?: Function }} operations
   * @param {readonly string[]} [settingsPath]
   * @returns {string[]}
   */
   function protocolChoices(root, provider, operations, settingsPath) {
     if (!isPlainObject(operations) || typeof operations.nodeAtPath !== "function") return [];
     if (!isNonEmptyString(provider)) return [];
     const profilePath = Array.isArray(settingsPath) && settingsPath.length > 0
      ? settingsPath
      : ["providers", provider];
     let node;
    try {
      node = operations.nodeAtPath(root, [...profilePath, "api"]);
    } catch {
      return [];
    }
    if (!isSchemaNode(node) || node.type !== "union" || !Array.isArray(node.list)) return [];
    return node.list
      .map((entry) => (isSchemaNode(entry) ? entry.value : undefined))
      .filter((value) => typeof value === "string" && value.length > 0);
  }

  /**
   * 创建一个基于 describe 视图的同步 schema 适配器。
   *
   * 只使用设置服务自己的公开面：schema 来自 describe 返回的 `SettingsNamespaceView.schema`，
   * rehydrate/validate/nodeAtPath 优先用注入的公开服务（DSH 的 `settingsSchema`）；宿主没有
   * 该服务时退化为"直接按 schemastery 的 `new Schema(信封)` 语义读取 schema 信封"，
   * 再没有就只能不校验（把拒绝留给正式 settings API）。因此这里既不碰 DSH 核心文件，
   * 也不复制 schemastery 的实现。
   *
   * @param {{ rehydrate?: Function, validate?: Function, nodeAtPath?: Function }} operations
   * @param {{ Schema?: Function }} [fallback] - 可选的结构化兜底（测试注入 schemastery 用）。
   */
  function createSchemaAdapter(operations, fallback) {
    const ops = isPlainObject(operations) ? operations : {};
    const schemaConstructor = isPlainObject(fallback) && typeof fallback.Schema === "function" ? fallback.Schema : null;
    const rehydrate = typeof ops.rehydrate === "function" ? ops.rehydrate : null;
    const validate = typeof ops.validate === "function" ? ops.validate : null;
    const nodeAtPath = typeof ops.nodeAtPath === "function" ? ops.nodeAtPath : null;
    /** 结构化兜底实现：与 DSH 公开服务同语义的遍历/校验最小集合。 */
    const structural = {
      rehydrate(serialized) {
        if (schemaConstructor === null) return undefined;
        try {
          return new schemaConstructor(serialized);
        } catch {
          return undefined;
        }
      },
      /**
       * 用 schema 节点自身做一次真实校验（DSH 的 schema 服务同语义：校验语义在节点上，
       * 服务只负责把抛错转成文本）。宿主没有 schmastery 构造器时退化为"不本地校验"，
       * 拒绝仍然由正式 settings API 负责。
       */
      validateNode(schema, draft) {
        if (schema === undefined || schema === null || typeof schema !== "function") return undefined;
        try {
          schema(draft);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      nodeAtPath(root, path) {
        let node = root;
        for (const key of Array.isArray(path) ? path : []) {
          if (node === null || node === undefined || typeof node !== "object") return undefined;
          if (node.type === "object") node = isPlainObject(node.dict) ? node.dict[key] : undefined;
          else if (node.type === "dict" || node.type === "array") node = node.inner;
          else return undefined;
        }
        return node;
      },
    };
    return {
      available: rehydrate !== null || schemaConstructor !== null,
      rehydrate(serialized) {
        if (rehydrate !== null) {
          try {
            return rehydrate(serialized);
          } catch {
            // 无法 rehydrate 的 schema 信封不能证明任何草稿合法：按"无 schema"处理。
            return undefined;
          }
        }
        return structural.rehydrate(serialized);
      },
      /**
       * 校验草稿；没有 schema 能力时返回 `undefined`（交给正式的 settings API 拒绝）。
       * @returns {string | undefined}
       */
      validate(schema, draft) {
        if (schema === undefined || schema === null) return undefined;
        if (validate !== null) {
          try {
            const outcome = validate(schema, draft);
            if (outcome !== undefined && outcome !== null) return String(outcome);
            // 注入的公开服务返回"通过"时仍需结构化复核：DSH 的 schema 服务只把
            // 抛错转成文本，真实校验语义始终在 schema 节点自身。
            return structural.validateNode(schema, draft);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
        return structural.validateNode(schema, draft);
      },
      nodeAtPath(root, path) {
        if (root === undefined || root === null) return undefined;
        if (nodeAtPath !== null) {
          try {
            return nodeAtPath(root, path);
          } catch {
            return undefined;
          }
        }
        return structural.nodeAtPath(root, path);
      },
    };
  }

  /**
   * 读取一个命名空间的 schema 节点与默认值（模型目录的继承来源）。
   * @param {{ schema?: unknown, value?: unknown, base?: unknown }} namespace
   * @param {ReturnType<typeof createSchemaAdapter>} adapter
   */
  function namespaceSchemaInfo(namespace, adapter) {
    const view = isPlainObject(namespace) ? namespace : {};
    const root = adapter === undefined ? undefined : adapter.rehydrate(view.schema);
    return {
      root,
      modelsNode: adapter === undefined ? undefined : adapter.nodeAtPath(root, ["models"]),
      defaultInput: (() => {
        const node = adapter === undefined ? undefined : adapter.nodeAtPath(root, ["defaultInput"]);
        const value = isSchemaNode(node) ? node.meta?.default : undefined;
        return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
      })(),
    };
  }

  /**
   * 卡片保存前的本地校验：只校验卡片有权编辑的字段。
   *
   * 未展示的未知字段不参与判定（它们也不产生路径操作），因此这里不会因为
   * 结构外字段而拒绝一次合法编辑。
   *
   * @param {Record<string, unknown>} draft - 卡片草稿（profile 子树）。
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateProfileDraft(draft) {
    if (!isPlainObject(draft)) return null;
    for (const field of ["displayName", "baseURL", "api", "apiKeyEnv"]) {
      const value = draft[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return field + " 必须是文本";
    }
    if (draft.models !== undefined) {
      const checked = validateModelRows(draft.models);
      if (!checked.ok) return checked.error;
    }
    return null;
  }

  // ── 角色联动：将要删除/取消的档位是否正被某些角色默认使用 ────────────────────

  /**
   * 计算受影响角色：provider 的某一档位将被删除（或该 provider 整体被删除）时，
   * `dsh-expert-group.defaults.<role>.reasoningEffort` 仍指向这一档的角色必须被列出。
   *
   * 绝不自动改写角色配置：调用方据此阻止保存并提示用户先去角色配置里改。
   *
   * @param {unknown} defaults - settings 里的 `defaults` 映射。
   * @param {{ provider: string, removedLevels?: readonly string[], removeProvider?: boolean }} change
   * @returns {Array<{ role: string, reasoningEffort: string }>}
   */
  function rolesAffectedByChange(defaults, change) {
    const source = isPlainObject(defaults) ? defaults : {};
    const provider = isNonEmptyString(change?.provider) ? change.provider : "";
    if (provider.length === 0) return [];
    const removed = new Set(
      (Array.isArray(change?.removedLevels) ? change.removedLevels : [])
        .filter((level) => typeof level === "string" && level.length > 0),
    );
    const removeProvider = change?.removeProvider === true;
    const affected = [];
    for (const [role, selection] of Object.entries(source)) {
      if (!isPlainObject(selection)) continue;
      if (selection.provider !== provider) continue;
      const effort = selection.reasoningEffort;
      if (typeof effort !== "string" || effort.length === 0) continue;
      if (removeProvider || removed.has(effort)) affected.push({ role, reasoningEffort: effort });
    }
    return affected;
  }

  /**
   * 角色联动拦截提示文案（中文，列出受影响角色）。
   * @param {readonly string[]} levels
   * @param {readonly { role: string, reasoningEffort: string }[]} affected
   * @param {(role: string) => string} [labelOf]
   * @returns {string}
   */
  function reasoningGuardMessage(levels, affected, labelOf) {
    const label = typeof labelOf === "function" ? labelOf : (role) => role;
    const parts = affected.map((entry) => label(entry.role) + "（" + entry.reasoningEffort + "）");
    return "无法保存：将删除的思考档位 " + levels.join("、") + " 正被以下专家角色使用：" + parts.join("、")
      + "。请先在这些角色的配置中改用其它档位，本页不会自动改写角色配置。";
  }

  /**
   * 从两份模型草稿算出"将被删除的档位"，只在保存前用于角色联动守卫。
   * @param {readonly unknown[]} before
   * @param {readonly unknown[]} after
   * @param {{ includeRemovedRows?: boolean }} [options]
   * @returns {string[]}
   */
  function removedLevelsOf(before, after, options) {
    const levels = new Set();
    const afterIndex = indexModelsById(after);
    const includeRemovedRows = isPlainObject(options) && options.includeRemovedRows === true;
    for (const row of modelDraftsOf(before)) {
      if (!isNonEmptyString(row.id)) continue;
      const id = row.id.trim();
      const nextRow = afterIndex.get(id);
      const previousLevels = selectedLevelsOf(row.reasoningEfforts);
      if (nextRow === undefined) {
        if (includeRemovedRows) for (const level of previousLevels) levels.add(level);
        continue;
      }
      const nextLevels = selectedLevelsOf(nextRow.reasoningEfforts);
      for (const level of previousLevels) if (!nextLevels.includes(level)) levels.add(level);
    }
    return [...levels];
  }

  // ── 设置文档读取（沿用公开 settings API 的视图形状） ───────────────────────

  /**
   * 从 describe 视图取出命名空间视图。
   * @param {unknown} view
   * @param {string} ns
   * @returns {Record<string, unknown> | undefined}
   */
  function namespaceViewOf(view, ns) {
    const namespaces = isPlainObject(view) && Array.isArray(view.namespaces) ? view.namespaces : [];
    return namespaces.find((entry) => isPlainObject(entry) && entry.ns === ns);
  }

  /**
   * 从 settings 快照读角色默认选择（角色联动的数据源）。
   * @param {unknown} settingsValue
   * @returns {Record<string, unknown>}
   */
  function roleDefaultsOf(settingsValue) {
    const defaults = isPlainObject(settingsValue) ? settingsValue.defaults : undefined;
    return isPlainObject(defaults) ? defaults : {};
  }

  /**
   * 决定一次提交要写什么：路径操作、将被取消的档位、以及角色的守卫结论。
   *
   * 卡片只把"自己的草稿 + 进入编辑态时已存储的用户层"交给这里，因此
   * - 未覆盖时：materialize 用户覆盖（写入卡片可见的全部字段）；
   * - 已覆盖时：相对权威用户层的最小 diff，外部提交的字段不会被误删；
   * - 空档位行 / 空白显示名等在草稿校验阶段就被拒绝，不进入这里。
   *
   * @param {{
   *   provider: string,
   *   profilePath: readonly string[],
   *   storedUser: unknown,
   *   draft: Record<string, unknown>,
   *   inheritedModels: readonly unknown[],
   *   roleDefaults: unknown,
   *   catalogTouched?: boolean,
   * }} input
   * @returns {{
   *   ops: Array<{ op: "set" | "unset", path: string[], value?: unknown }>,
   *   removedLevels: string[],
   *   affectedRoles: Array<{ role: string, reasoningEffort: string }>,
   * }}
   */
  function modelCardApply(input) {
    const source = isPlainObject(input) ? input : {};
    const catalogTouched = source.catalogTouched === true;
    const profilePath = Array.isArray(source.profilePath) ? source.profilePath : [];
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const storedUser = source.storedUser;
    const baseline = { userSubtree: getSubtree(storedUser, profilePath) };
    const ops = modelCatalogOps({ profilePath, baseline, draft, catalogTouched });
    const rows = catalogTouched
      ? (Array.isArray(draft.models) ? draft.models : [])
      : [];
    const removedLevels = catalogTouched
      ? removedLevelsOf(source.inheritedModels, rows, { includeRemovedRows: source.catalogReset === true })
      : [];
    const affectedRoles = removedLevels.length === 0
      ? []
      : rolesAffectedByChange(source.roleDefaults, { provider: source.provider, removedLevels });
    return { ops, removedLevels, affectedRoles, rows };
  }

  /**
   * provider 目录行的渲染面：与 DSH 内置模型设置页同一份 join 结果，只补上"是否已由用户配置"。
   *
   * @param {readonly Record<string, unknown>[]} rows
   * @param {(ns: string) => Record<string, unknown> | undefined} namespaceOf
   * @returns {{ configured: Record<string, unknown>[], addable: Record<string, unknown>[] }}
   */
  function providerListSections(rows, namespaceOf) {
    const lookup = typeof namespaceOf === "function" ? namespaceOf : () => undefined;
    const sections = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isPlainObject(row)) continue;
      const namespace = lookup(row.settingsNs);
      if (!isPlainObject(namespace)) continue;
      sections.push({
        row,
        namespace,
        // 用户层存在该 profile 才算"已配置"：值等于默认值也仍是覆盖，只看键是否存在。
        configured: hasPath(namespace.user, row.settingsPath),
      });
    }
    return {
      configured: sections.filter((entry) => entry.configured),
      addable: sections.filter((entry) => !entry.configured),
    };
  }

  /**
   * API Key 输入框的渲染面：只写不读明文、可按状态禁用、并给出引用提示。
   *
   * @param {{ provider: string, credentialRef: string, credential?: { configured?: boolean, writable?: boolean }, typed?: string, readOnly?: boolean }} input
   * @returns {{ ref: string, value: string, type: "password", autoComplete: "off", disabled: boolean, placeholder: string, hint: string }}
   */
  function apiKeyField(input) {
    const source = isPlainObject(input) ? input : {};
    const configured = isPlainObject(source.credential) && source.credential.configured === true;
    const writable = !isPlainObject(source.credential) || source.credential.writable !== false;
    const ref = isNonEmptyString(source.credentialRef) ? source.credentialRef : "";
    return {
      ref,
      value: typeof source.typed === "string" ? source.typed : "",
      type: "password",
      autoComplete: "off",
      disabled: source.readOnly === true || !writable,
      placeholder: writable ? (configured ? "已配置（留空表示不修改）" : "粘贴 API Key 后点应用") : "当前凭据只读",
      hint: ref.length === 0 ? "未设置凭据引用" : "凭据引用：" + ref + "（API Key 只写入 credentials 服务，保存后不回显明文）",
    };
  }

  /**
   * provider 卡片的渲染面：把"卡片看到的数据 + 可执行动作"收敛成一个可断言的对象。
   *
   * 界面按它渲染，测试按它断言，因此"模型配置区有哪些控件、哪些默认值、哪些禁用条件"
   * 不需要依赖 React 渲染器也能被验证。
   *
   * @param {{
   *   row: Record<string, unknown>,
   *   namespace: Record<string, unknown>,
   *   draft: Record<string, unknown>,
   *   expandedRows?: ReadonlySet<number> | readonly number[],
   *   defaultInput?: readonly string[],
   *   protocols?: readonly string[],
   *   credentialRef?: string,
   *   credential?: { configured?: boolean, writable?: boolean },
   *   typed?: string,
   *   readOnly?: boolean,
   *   fallbackModels?: readonly unknown[],
   * }} input
   */
  function buildModelCardModel(input) {
    const source = isPlainObject(input) ? input : {};
    const row = isPlainObject(source.row) ? source.row : {};
    const profilePath = Array.isArray(row.settingsPath) ? row.settingsPath : [];
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const inherited = modelDraftsOf(source.fallbackModels);
    const models = Array.isArray(draft.models) ? modelDraftsOf(draft.models) : inherited;
    // 「已按用户覆盖」= 草稿里有一份**非空**的模型目录。清空目录（恢复默认的草稿态）
    // 意味着回到适配器默认，而不是一份空覆盖。
    const overridden = typeof source.catalogOverridden === "boolean"
       ? source.catalogOverridden
       : Array.isArray(draft.models) && draft.models.length > 0;
    const expanded = new Set(
      source.expandedRows instanceof Set
        ? [...source.expandedRows]
        : (Array.isArray(source.expandedRows) ? source.expandedRows : []),
    );
    const defaultInput = Array.isArray(source.defaultInput) ? source.defaultInput : undefined;
    const credential = isPlainObject(source.credential) ? source.credential : undefined;
    const apiKey = apiKeyField({
      provider: row.provider,
      credentialRef: source.credentialRef ?? credentialRefOf(row, source.namespace),
      credential,
      typed: typeof source.typed === "string" ? source.typed : "",
      readOnly: source.readOnly === true,
    });
    const nameOf = (field, model) => {
      if (field === "id") return typeof model.id === "string" ? model.id : "";
      return typeof model.name === "string" ? model.name : "";
    };
    return {
      provider: row.provider,
      displayName: isNonEmptyString(row.displayName) ? row.displayName : row.provider,
      profilePath,
      readOnly: source.readOnly === true,
      apiKey,
      baseUrl: {
        value: typeof draft.baseURL === "string" ? draft.baseURL : "",
        placeholder: "留空表示使用适配器默认端点",
      },
      protocol: {
        value: typeof draft.api === "string" ? draft.api : "",
        options: [{
          value: "",
          label: "适配器默认",
        }, ...(Array.isArray(source.protocols) ? source.protocols : [])
          .filter((choice) => typeof choice === "string" && choice.length > 0)
          .map((choice) => ({ value: choice, label: choice }))],
      },
      models: models.map((model, index) => {
        const selection = effortSelectionFor(model);
        const inputSelected = modelInputOf(model, defaultInput);
        return {
          index,
          position: index + 1,
          id: { value: nameOf("id", model), editable: true },
          name: { value: nameOf("name", model), editable: true },
          contextWindow: {
            value: typeof model.contextWindow === "number" ? formatCapacity(model.contextWindow) : "",
            placeholder: "继承适配器默认",
          },
          maxTokens: {
            value: typeof model.maxTokens === "number" ? formatCapacity(model.maxTokens) : "",
            placeholder: "继承适配器默认",
          },
          reasoningDefaults: { value: "模型默认", editable: false },
          efforts: REASONING_EFFORTS.map((level) => ({ level, checked: selection[level] === true })),
          inputs: INPUT_MODALITIES.map((modality) => ({
            modality,
            checked: inputSelected.includes(modality),
            // 至少保留一个输入类型：只剩一个已勾选项时该项不可再取消。
            locked: inputSelected.length === 1 && inputSelected.includes(modality),
          })),
          advancedOpen: expanded.has(index),
        };
      }),
      modelCatalog: {
        overridden,
        label: overridden ? "已按用户覆盖" : "适配器默认（首次编辑时写入用户覆盖）",
        emptyHint: "没有模型：留空表示沿用适配器内置目录",
        canReset: overridden,
      },
      actions: {
        apply: source.readOnly === true ? "disabled" : "enabled",
        cancel: "enabled",
        fetchModels: source.readOnly === true ? "disabled" : "enabled",
        addModel: source.readOnly === true ? "disabled" : "enabled",
        addProvider: source.readOnly === true ? "disabled" : "enabled",
        removeProvider: source.readOnly === true ? "disabled" : "enabled",
        edit: "enabled",
      },
    };
  }

  /**
   * provider 卡片的一次编辑会话（纯状态机，界面与测试共用）。
   *
   * 它只做与渲染无关的判定：合并草稿、算动作、校验、以及一次成功/失败提交的结论，
   * 因此"每个卡片独立应用/取消 + revision 冲突保护 + 角色联动守卫"可以在没有 React
   * 渲染器的情况下被完整验证。
   *
   * @param {{ provider: string, settingsNs?: string, profilePath: readonly string[], storedUser: unknown, value: unknown, revision: number, roleDefaults?: unknown }} input
   */
  function createCardSession(input) {
    const source = isPlainObject(input) ? input : {};
    const provider = isNonEmptyString(source.provider) ? source.provider : "";
    const settingsNs = typeof source.settingsNs === "string" ? source.settingsNs : "";
    const profilePath = Array.isArray(source.profilePath) ? source.profilePath : [];
    const startingUser = isPlainObject(source.storedUser) ? source.storedUser : {};
    let appliedUser = deepClone(startingUser);
    let currentEffective = source.value;
    let baseline = createEditorBaseline({
      revision: source.revision,
      user: appliedUser,
      base: source.base,
      value: currentEffective,
    }, profilePath);
    let fallbackModels = fallbackModelsOf(baseline);
    let draft = importNamespace(
      !isPlainObject(currentEffective) || profilePath.length === 0
        ? currentEffective
        : getPath(currentEffective, profilePath),
    );
    let catalogTouched = false;
    let catalogReset = false;
    let keyDraft = "";
    let closed = false;
    return {
      provider,
      settingsNs,
      profilePath,
      get draft() { return draft; },
      get revision() { return baseline.revision; },
      get closed() { return closed; },
      get overridden() {
        return catalogTouched
          ? Array.isArray(draft.models) && draft.models.length > 0
          : modelCatalogOverridden(baseline);
      },
      get modelRows() {
        return Array.isArray(draft.models) ? modelDraftsOf(draft.models) : modelDraftsOf(fallbackModels);
      },
      /** 交给渲染面的当前模型（与界面渲染用的是同一份数据）。 */
      cardModel(extra = {}) {
        return buildModelCardModel({
          row: { provider, settingsPath: profilePath },
          draft,
          fallbackModels: fallbackModels,
          catalogOverridden: catalogTouched
             ? Array.isArray(draft.models) && draft.models.length > 0
             : modelCatalogOverridden(baseline),
          ...extra,
        });
      },
      /** 用户开始编辑：首次编辑才把生效值导入草稿（等价于 materialize 用户覆盖）。 */
      edit(update) {
        if (closed) return draft;
        const imported = catalogReset || Array.isArray(draft.models) || fallbackModels.length === 0
          ? draft
          : { ...draft, models: deepClone(fallbackModels) };
        const beforeModels = isPlainObject(imported) && Object.prototype.hasOwnProperty.call(imported, "models")
          ? imported.models
          : undefined;
        const next = update(imported);
        const afterModels = isPlainObject(next) && Object.prototype.hasOwnProperty.call(next, "models")
          ? next.models
          : undefined;
        if (!jsonEqual(beforeModels, afterModels)) catalogTouched = true;
        draft = next;
        return draft;
      },
      /** 恢复默认：删除用户覆盖（草稿层）。 */
      resetModels() {
        catalogTouched = true;
        catalogReset = true;
        draft = deletePath(draft, ["models"]);
        return draft;
      },
      setFallbackModels(models) {
        fallbackModels = modelDraftsOf(models);
        return fallbackModels;
      },
      typeKey(value) {
        keyDraft = typeof value === "string" ? value : "";
        return keyDraft;
      },
      /** 尚未提交的 API Key 明文（只存在于卡片内存里，用于"获取模型"探测）。 */
      get keyValue() { return keyDraft.trim(); },
      /** 取消：丢弃草稿与凭据输入，回到当前已存储状态（含已接受的权威视图）。 */
      cancel() {
        draft = importNamespace(
          !isPlainObject(currentEffective) || profilePath.length === 0
            ? currentEffective
            : getPath(currentEffective, profilePath),
        );
        catalogTouched = false;
        catalogReset = false;
        keyDraft = "";
        return draft;
      },
      /**
       * 计算一次"应用"的结果，但**不落盘**：返回要提交的路径操作与凭据输入，
       * 由宿主面负责真正写入（正式 settings API + credentials 服务）。
       */
      plan() {
        const key = keyDraft.trim();
        // pi-ai only names the conventional credential reference when a key is
        // actually supplied. Without this field the credential would be stored
        // successfully but the provider profile would not point at it.
        const draftForSave = key.length > 0 && settingsNs === "llm-pi-ai"
          && !isNonEmptyString(draft.apiKeyEnv)
          ? { ...draft, apiKeyEnv: deriveKeyRef(provider) }
          : draft;
        const validation = validateProfileDraft(draftForSave);
        if (validation !== null) return { ok: false, error: validation };
        if (Array.isArray(draftForSave.models)) {
          const rows = validateModelRows(draftForSave.models);
          if (!rows.ok) return { ok: false, error: rows.error };
        }
        const result = modelCardApply({
          provider,
          profilePath,
          storedUser: appliedUser,
          draft: draftForSave,
          inheritedModels: inheritedModelsOf(baseline).models,
          roleDefaults: source.roleDefaults,
          catalogTouched,
          catalogReset,
        });
        if (result.affectedRoles.length > 0) {
          return {
            ok: false,
            guard: true,
            removedLevels: result.removedLevels,
            affectedRoles: result.affectedRoles,
            error: reasoningGuardMessage(result.removedLevels, result.affectedRoles),
          };
        }
        const settingsDraft = deletePath(draftForSave, ["models"]);
        const ops = result.ops.length === 0 && key.length > 0 && !hasPath(appliedUser, profilePath)
          && Object.keys(settingsDraft).length === 0
          ? [{ op: "set", path: [...profilePath], value: {} }]
          : result.ops;
        return {
          ok: true,
          ops,
          expectedRevision: baseline.revision,
          keyValue: key.length === 0 ? undefined : key,
        };
      },
      /**
       * 提交成功后的收口：接受权威用户层与 revision 作为新基线，草稿回到已存储状态。
       *
       * 只接受卡片有权编辑的字段（隐藏高级字段继续留在用户层里，由宿主视图负责），
       * 因此接受之后的 plan() 恒为"无待提交操作"。
       */
      accept(view) {
        if (isPlainObject(view)) {
          appliedUser = isPlainObject(view.user) ? deepClone(view.user) : {};
          currentEffective = view.value;
          baseline = createEditorBaseline({
            revision: view.revision,
            user: appliedUser,
            base: view.base,
            value: view.value,
          }, profilePath);
          fallbackModels = fallbackModelsOf(baseline);
          draft = importNamespace(
            !isPlainObject(view.value) || profilePath.length === 0
              ? view.value
              : getPath(view.value, profilePath),
          );
        }
        catalogTouched = false;
        catalogReset = false;
        return draft;
      },
      close() {
        closed = true;
        return draft;
      },
    };
  }

  /**
   * 「模型配置」折叠区的渲染面：区域默认折叠、标题中文、展开后才读取目录。
   *
   * 两个 provider 入口与原生模型设置页同级：
   * - 添加提供方：从 DSH 已知但用户层尚未配置的 provider 中选择；
   * - 添加自定义提供方：声明 DSH 目录中不存在的新 route，需要 `llm-pi-ai` namespace
   *   提供至少一个合法协议，并且 settings 文档可写。
   *
   * @param {{
   *   open?: boolean,
   *   status?: string,
   *   configured?: readonly unknown[],
   *   addable?: readonly unknown[],
   *   error?: string | null,
   *   writable?: boolean,
   *   protocols?: readonly unknown[],
   *   canCreateCustom?: boolean,
   * }} input
   */
  function buildSectionModel(input) {
    const source = isPlainObject(input) ? input : {};
    const open = source.open === true;
    const status = typeof source.status === "string" ? source.status : "idle";
    const readOnly = source.writable === false;
    const addableCount = Array.isArray(source.addable) ? source.addable.length : 0;
    // 自定义入口的可用性独立判定：schema 能给出合法协议才可能提交，否则入口禁用而不是
    // 打开一张永远无法提交的卡片。
    const customAllowed = source.canCreateCustom === true;
    return {
      title: "模型配置",
      open,
      // 默认折叠是需求本身：折叠时既不渲染卡片，也不读取 provider 目录。
      disclosure: { expanded: open, bodyId: "deg-model-config-body", label: open ? "收起" : "展开" },
      status,
      loading: status === "loading",
      error: typeof source.error === "string" && source.error.length > 0 ? source.error : null,
      readOnly,
      configuredCount: Array.isArray(source.configured) ? source.configured.length : 0,
      addableCount,
      entries: {
        addProvider: { label: "添加提供方" },
        addCustom: { label: "添加自定义提供方", protocols: Array.isArray(source.protocols) ? source.protocols.length : 0 },
      },
      actions: {
        toggle: "enabled",
        addProvider: readOnly || status !== "ready" || addableCount === 0 ? "disabled" : "enabled",
        addCustom: readOnly || status !== "ready" || !customAllowed ? "disabled" : "enabled",
        reload: status === "loading" ? "disabled" : "enabled",
      },
      hint: "与 DSH 内置模型设置页同一份数据流：provider 目录、凭据状态与模型目录都来自宿主公开接口，保存走正式 settings API 与 schema 校验。",
    };
  }

  // ── 自定义 provider 创建（route id / Base URL / 协议 / 模型 校验） ─────────────

  /**
   * 自定义 provider 的 route id 词表：小写字母开头，只含小写字母、数字与连字符。
   *
   * 点号、下划线与其它标点一律排除，因为凭据引用由 route id 推导
   * （`deriveKeyRef` 把每段非字母数字折叠成一个下划线），允许这类字符会让
   * `a.b`、`a-b`、`a_b` 全部折叠到同一个引用而产生凭据冲突。这条规则同时是原生
   * provider 路由使用的字符集（字母/数字/连字符）。
   */
  const ROUTE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

  /** 没有 `URL` 构造器时的降级检查（只做形状校验，不解析端口与 IPv6）。 */
  const BASE_URL_FALLBACK_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

  /**
   * 校验自定义 provider 的 Base URL。
   *
   * 用 `URL` 构造器而不是正则：端口、IPv6 方括号、百分号编码与主机名存在性都由平台
   * 解析器判定，正则无法覆盖（例如 `https://[::1` 未闭合、`https://host:99999` 非法端口、
   * `https://` 缺失主机都必须是错误）。降级路径只在宿主环境没有 `URL` 时使用。
   *
   * @param {unknown} value
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateBaseUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) return "请填写 Base URL（HTTP 或 HTTPS）";
    const trimmed = value.trim();
    const UrlConstructor = typeof URL === "function" ? URL : undefined;
    if (UrlConstructor === undefined) {
      return BASE_URL_FALLBACK_PATTERN.test(trimmed) ? null : "Base URL 必须以 http:// 或 https:// 开头，并包含主机名";
    }
    let parsed;
    try {
      parsed = new UrlConstructor(trimmed);
    } catch {
      // 未闭合的 IPv6 字面量、非法端口、缺少 scheme 等都会走到这里。
      return "Base URL 不是合法的 URL（请检查协议、主机、端口与括号）";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Base URL 只支持 http:// 或 https://";
    }
    if (typeof parsed.hostname !== "string" || parsed.hostname.length === 0) {
      return "Base URL 必须包含主机名";
    }
    if (parsed.port !== "") {
      const port = Number(parsed.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return "Base URL 的端口必须在 1-65535 之间";
    }
    return null;
  }

  /**
   * 校验自定义 provider 的 route id。
   *
   * 去重同时按原始 route 与推导出的凭据引用判定：`a-b` 与 `ab` 这类不同 route 只要折叠出
   * 同一个 credential ref 就必须拒绝，否则第二个 provider 会静默复用第一个的 API Key。
   *
   * @param {unknown} value
   * @param {readonly string[]} [taken] - 已经存在的 route id（DSH 目录与已配置 provider）。
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateRouteId(value, taken) {
    if (typeof value !== "string") return "请填写 provider 路由 ID";
    const trimmed = value.trim();
    if (trimmed.length === 0) return "请填写 provider 路由 ID";
    if (trimmed.length < 2) return "provider 路由 ID 至少 2 个字符";
    if (trimmed.length > 64) return "provider 路由 ID 最多 64 个字符";
    if (!ROUTE_ID_PATTERN.test(trimmed)) {
      return "provider 路由 ID 只允许小写字母、数字与连字符，且必须以字母开头、字母或数字结尾";
    }
    const existing = (Array.isArray(taken) ? taken : []).filter((id) => isNonEmptyString(id));
    if (existing.includes(trimmed)) return "provider「" + trimmed + "」已存在，请改用其它路由 ID";
    const wantedRef = deriveKeyRef(trimmed);
    const collided = existing.find((id) => id !== trimmed && deriveKeyRef(id) === wantedRef);
    if (collided !== undefined) {
      return "provider「" + trimmed + "」与「" + collided + "」会使用同一个凭据引用（"
        + wantedRef + "），请改用其它路由 ID";
    }
    return null;
  }

  /**
   * 校验自定义 provider 的协议：必须是宿主 schema 暴露的合法协议之一。
   * @param {unknown} value
   * @param {readonly string[]} [protocols]
   * @returns {string | null}
   */
  function validateProtocol(value, protocols) {
    const allowed = (Array.isArray(protocols) ? protocols : []).filter((entry) => isNonEmptyString(entry));
    if (allowed.length === 0) return "当前宿主没有提供可用的协议选项";
    if (!isNonEmptyString(value)) return "请选择协议";
    return allowed.includes(value) ? null : "协议「" + value + "」不在宿主支持的协议列表中";
  }

  /**
   * 校验自定义 provider 的完整草稿。
   *
   * 字段级错误同时返回，便于卡片逐字段提示；`ok` 只在整个草稿都能提交时为 true。
   *
   * @param {{
   *   routeId?: unknown,
   *   displayName?: unknown,
   *   baseURL?: unknown,
   *   api?: unknown,
   *   models?: unknown,
   *   apiKey?: unknown,
   *   takenRoutes?: readonly string[],
   *   protocols?: readonly string[],
   * }} input
   * @returns {{ ok: boolean, errors: Record<string, string>, error: string | null, routeId: string, profile: Record<string, unknown>, models: Record<string, unknown>[], apiKey: string }}
   */
  function validateCustomProviderDraft(input) {
    const source = isPlainObject(input) ? input : {};
    const errors = {};
    const routeId = typeof source.routeId === "string" ? source.routeId.trim() : "";
    const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
    const baseURL = typeof source.baseURL === "string" ? source.baseURL.trim() : "";
    const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));

    const routeFailure = validateRouteId(routeId, source.takenRoutes);
    if (routeFailure !== null) errors.routeId = routeFailure;
    const urlFailure = validateBaseUrl(baseURL);
    if (urlFailure !== null) errors.baseURL = urlFailure;
    const protocolFailure = validateProtocol(source.api, protocols);
    if (protocolFailure !== null) errors.api = protocolFailure;
    if (displayName.length > 0 && displayName.length > 200) errors.displayName = "显示名最多 200 个字符";

    const rows = normalizeModelRows(source.models);
    if (rows.length === 0) errors.models = "至少配置一个模型";
    else {
      const checked = validateModelRows(rows);
      if (!checked.ok) errors.models = checked.error;
    }

    const profile = {};
    if (routeFailure === null && urlFailure === null && protocolFailure === null && Object.keys(errors).length === 0) {
      // 只有真正要写凭据时才声明凭据引用：留空 API Key 表示使用 provider 原生/环境凭据
      // （ambient authentication），此时写入 `apiKeyEnv` 会让宿主去找一条永远不存在的密钥。
      if (apiKey.length > 0) profile.apiKeyEnv = deriveKeyRef(routeId);
      if (displayName.length > 0) profile.displayName = displayName;
      profile.baseURL = baseURL;
      profile.api = source.api;
      profile.models = rows;
    }
    const firstError = Object.keys(errors).length === 0 ? null : errors[Object.keys(errors)[0]];
    return {
      ok: Object.keys(errors).length === 0,
      errors,
      error: firstError,
      routeId,
      profile,
      models: rows,
      apiKey,
    };
  }

  /**
   * 自定义 provider 创建卡片的**状态机**（纯状态机，界面与测试共用）。
   *
   * 二阶段提交是这里最重要的语义：settings（profile）先写，API Key 再单独写
   * credentials。settings 成功后把 `settingsCommitted` 固定下来，因此 credentials
   * 写入失败后的重试只重试 credentials，绝不会重复 mutate 已经写好的 profile。
   *
   * @param {{
   *   settingsNs: string,
   *   profileBasePath: readonly string[],
   *   revision: number,
   *   protocols?: readonly string[],
   *   takenRoutes?: readonly string[],
   *   displayName?: string,
   *   models?: readonly unknown[],
   * }} input
   */
  function createCustomProviderDraft(input) {
    const source = isPlainObject(input) ? input : {};
    const settingsNs = typeof source.settingsNs === "string" ? source.settingsNs : "";
    const profileBasePath = Array.isArray(source.profileBasePath) ? source.profileBasePath : [];
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));
    let takenRoutes = (Array.isArray(source.takenRoutes) ? source.takenRoutes : [])
      .filter((entry) => isNonEmptyString(entry));
    // 栅栏是否已经定稿：定稿后 rebase 不再改写 revision（只为冲突语义保留）。
    let fenceFrozen = false;
    let draft = {
      routeId: "",
      displayName: typeof source.displayName === "string" ? source.displayName : "",
      baseURL: "",
      api: protocols.length === 1 ? protocols[0] : "",
      apiKey: "",
      models: modelDraftsOf(source.models ?? [createModelRow()]),
    };
    let settingsCommitted = false;
    let committedRevision = null;
    let committedProfilePath = null;
    let committedCredentialRef = null;
    let expectedRevision = Number.isSafeInteger(source.revision) ? source.revision : undefined;

    /** 已提交后的凭据引用：固定成提交那一刻推导出的值，绝不再随 route 编辑漂移。 */
    const committedRef = () => (
      committedCredentialRef !== null
        ? committedCredentialRef
        : deriveKeyRef(typeof draft.routeId === "string" ? draft.routeId.trim() : "")
    );
    return {
      settingsNs,
      get draft() { return draft; },
      get settingsCommitted() { return settingsCommitted; },
      get committedProfilePath() { return committedProfilePath; },
      /** 已提交时为固定引用，未提交时按当前 route 推导（便于卡片展示预期引用）。 */
      get credentialRef() { return committedRef(); },
      get revision() { return committedRevision === null ? expectedRevision : committedRevision; },
      /**
       * 同步候选 route 词表（任何时候都同步），并在**尚未写盘前**接受一次 revision 纠正。
       *
       * revision 语义：
       * - 用户开始编辑、以及 settings 写成功之后，栅栏完全冻结。此后 mirror/load 推进
       *   revision 时自动跟随会让 CAS 失效，从而可能覆盖别人在这段时间里的写入；这种情况
       *   必须交给宿主按 revision 语义拒绝，界面再提示用户重新打开。
       * - 在这之前（刚打开卡片、还没输入任何字符）允许用最新 revision 纠正：卡片可能在
       *   Describe 视图还没读到/还过期时打开，用陈旧栅栏会把每一次正常提交都误判成冲突。
       *
       * `takenRoutes` 不受上述限制：route 占用情况任何时候都应该是最新的。
       *
       * @param {{ revision?: number, takenRoutes?: readonly string[], frozen?: boolean }} next
       */
      rebase(next) {
        if (settingsCommitted) return draft;
        const snapshot = isPlainObject(next) ? next : {};
        // 定稿这一次仍允许贴上 revision，之后就只读。
        if (!fenceFrozen && Number.isSafeInteger(snapshot.revision)) {
          expectedRevision = snapshot.revision;
        }
        if (snapshot.frozen === true) fenceFrozen = true;
        if (Array.isArray(snapshot.takenRoutes)) {
          takenRoutes = snapshot.takenRoutes.filter((entry) => isNonEmptyString(entry));
        }
        return draft;
      },
      /**
       * 编辑草稿：`patch` 里出现的键整体替换，未出现的键原样保留。
       *
       * `settingsCommitted` 之后只允许修改 API Key：profile 已经按当时的 route/字段落盘，
       * 再改 route、URL、协议或模型就会让界面描述的东西与实际写入的 provider 不一致，
       * 凭据也会被写到另一条引用上。这里的拒绝是状态机级的不变式，界面同时会禁用这些字段。
       */
      edit(patch) {
        const next = { ...draft };
        for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
          if (settingsCommitted && key !== "apiKey") continue;
          if (key === "models") next.models = modelDraftsOf(value);
          else if (isBlankDraftValue(value)) next[key] = "";
          else next[key] = value;
        }
        draft = next;
        return draft;
      },
      /** 校验草稿；返回逐字段错误与将要写入的 profile。 */
      validate() {
        return validateCustomProviderDraft({
          routeId: draft.routeId,
          displayName: draft.displayName,
          baseURL: draft.baseURL,
          api: draft.api,
          apiKey: draft.apiKey,
          models: draft.models,
          takenRoutes,
          protocols,
        });
      },
      /** profile 在命名空间内的完整路径（route id 是路径最后一段）。 */
      profilePath() {
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        return routeId.length === 0 ? null : [...profileBasePath, routeId];
      },
      /**
       * 一次提交的结论。
       *
       * 已经写成功 profile 时只返回凭据阶段（`ops` 为 undefined），因此重试不会重复
       * settings mutate。凭据阶段使用**提交时固定**的 credential ref，即使卡片上的
       * route 字段后来被改动过，也不会出现"旧 profile + 新 route 的凭据"错配。
       *
       * @returns {{ ok: boolean, error?: string, errors?: Record<string, string>, phase?: "settings" | "credentials" | "done", ops?: Array<{ op: "set", path: string[], value: unknown }>, credentialRef?: string, keyValue?: string, expectedRevision?: number }}
       */
      plan() {
        const keyValue = typeof draft.apiKey === "string" ? draft.apiKey.trim() : "";
        if (settingsCommitted) {
          const credentialRef = committedRef();
          return keyValue.length === 0
            ? { ok: true, phase: "done", credentialRef, keyValue: undefined }
            : { ok: true, phase: "credentials", credentialRef, keyValue };
        }
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        const credentialRef = routeId.length === 0 ? "" : deriveKeyRef(routeId);
        const checked = this.validate();
        if (!checked.ok) {
          return { ok: false, error: checked.error, errors: checked.errors };
        }
        const profilePath = this.profilePath();
        return {
          ok: true,
          phase: "settings",
          credentialRef,
          keyValue: keyValue.length === 0 ? undefined : keyValue,
          expectedRevision,
          ops: [{ op: "set", path: profilePath, value: deepClone(checked.profile) }],
        };
      },
      /**
       * settings 阶段成功：固定 profile 已写入的事实、新的 revision 与凭据引用。
       *
       * **保留** API Key 明文输入：profile 已经落盘，但凭据可能还没写成功（credentials
       * 服务失败、用户中断）。只要明文还在卡片内存里，重复点击提交就只会重试凭据写入，
       * 绝不会重复 mutate settings。明文不进入 settings、不回显在输入框以外的地方，
       * 并在凭据写入成功（`acceptCredential`）或卡片关闭时被丢弃。
       */
      acceptSettings(view, credentialRef) {
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        settingsCommitted = true;
        committedProfilePath = [...profileBasePath, routeId];
        committedCredentialRef = isNonEmptyString(credentialRef) ? credentialRef : deriveKeyRef(routeId);
        if (isPlainObject(view) && Number.isSafeInteger(view.revision)) committedRevision = view.revision;
        return draft;
      },
      /** credentials 阶段成功：清空明文输入。 */
      acceptCredential() {
        draft = { ...draft, apiKey: "" };
        return draft;
      },
    };
  }

  /** 自定义创建入口的可用性：`llm-pi-ai` namespace 存在 + 至少一个协议 + settings 可写。 */
  function canCreateCustomProvider({ namespace, protocols, writable } = {}) {
    if (!isPlainObject(namespace)) return false;
    if (writable === false) return false;
    return (Array.isArray(protocols) ? protocols : []).some((entry) => isNonEmptyString(entry));
  }

  /**
   * 自定义 provider 创建卡片的渲染面：与 provider 卡片同层的可断言对象。
   *
   * @param {{
   *   draft: Record<string, unknown>,
   *   protocols?: readonly string[],
   *   errors?: Record<string, string>,
   *   error?: string | null,
   *   readOnly?: boolean,
   *   saving?: boolean,
   *   submitted?: boolean,
   *   credentialRef?: string,
   *   defaultInput?: readonly string[],
   *   expandedRows?: ReadonlySet<number> | readonly number[],
   * }} input
   */
  function buildCustomCardModel(input) {
    const source = isPlainObject(input) ? input : {};
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const errors = isPlainObject(source.errors) ? source.errors : {};
    const readOnly = source.readOnly === true;
    const saving = source.saving === true;
    const submitted = source.submitted === true;
    const expanded = new Set(
      source.expandedRows instanceof Set
        ? [...source.expandedRows]
        : (Array.isArray(source.expandedRows) ? source.expandedRows : []),
    );
    const defaultInput = Array.isArray(source.defaultInput) ? source.defaultInput : undefined;
    const rows = modelDraftsOf(draft.models);
    const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));
    const disabled = readOnly || saving;
    // profile 已经写盘之后只允许重试 API Key：route 与 credential ref 都可能已经落盘，
    // 继续编辑它们会让"旧 profile + 新 route 的凭据"错配。固定字段在这里统一禁用。
    const profileLocked = submitted || readOnly;
    const profileDisabled = profileLocked || saving;
    const credentialRef = isNonEmptyString(source.credentialRef)
      ? source.credentialRef
      : (routeId.length === 0 ? "" : deriveKeyRef(routeId));
    return {
      title: "添加自定义提供方",
      readOnly,
      saving,
      submitted,
      profileLocked,
      credentialRef,
      error: isNonEmptyString(source.error) ? source.error : null,
      routeId: {
        value: routeId,
        error: isNonEmptyString(errors.routeId) ? errors.routeId : null,
        credentialRef,
        disabled: profileDisabled,
      },
      displayName: {
        value: typeof draft.displayName === "string" ? draft.displayName : "",
        error: isNonEmptyString(errors.displayName) ? errors.displayName : null,
        disabled: profileDisabled,
      },
      baseUrl: {
        value: typeof draft.baseURL === "string" ? draft.baseURL : "",
        error: isNonEmptyString(errors.baseURL) ? errors.baseURL : null,
        placeholder: "https://api.example.com/v1",
        disabled: profileDisabled,
      },
      protocol: {
        value: typeof draft.api === "string" ? draft.api : "",
        error: isNonEmptyString(errors.api) ? errors.api : null,
        disabled: profileDisabled,
        options: protocols.map((choice) => ({ value: choice, label: choice })),
      },
      apiKey: {
        value: typeof draft.apiKey === "string" ? draft.apiKey : "",
        type: "password",
        autoComplete: "off",
        disabled,
        placeholder: "粘贴 API Key（可留空，沿用 provider 原生/环境凭据）",
      },
      models: rows.map((model, index) => {
        const selection = effortSelectionFor(model);
        const inputSelected = modelInputOf(model, defaultInput);
        return {
          index,
          position: index + 1,
          id: { value: typeof model.id === "string" ? model.id : "" },
          name: { value: typeof model.name === "string" ? model.name : "" },
          contextWindow: {
            value: typeof model.contextWindow === "number" ? formatCapacity(model.contextWindow) : "",
            placeholder: "继承适配器默认",
          },
          maxTokens: {
            value: typeof model.maxTokens === "number" ? formatCapacity(model.maxTokens) : "",
            placeholder: "继承适配器默认",
          },
          efforts: REASONING_EFFORTS.map((level) => ({ level, checked: selection[level] === true })),
          inputs: INPUT_MODALITIES.map((modality) => ({
            modality,
            checked: inputSelected.includes(modality),
            locked: inputSelected.length === 1 && inputSelected.includes(modality),
          })),
          advancedOpen: expanded.has(index),
        };
      }),
      modelsError: isNonEmptyString(errors.models) ? errors.models : null,
      actions: {
        // 提交后在 settings 阶段成功前仍可提交（用于重试凭据写入）；route 固定后依然满足。
        submit: disabled || routeId.length === 0 ? "disabled" : "enabled",
        cancel: saving ? "disabled" : "enabled",
        addModel: profileLocked ? "disabled" : (disabled ? "disabled" : "enabled"),
      },
    };
  }

  const api = Object.freeze({
    SYMBOL,
    REASONING_EFFORTS,
    REASONING_EFFORT_EMPTY,
    INPUT_MODALITIES,
    DEFAULT_INPUT_MODALITIES,
    isPlainObject,
    isSchemaNode,
    isNonEmptyString,
    jsonEqual,
    deepClone,
    getPath,
    hasPath,
    setPath,
    deletePath,
    getSubtree,
    deriveKeyRef,
    modelDisplayNameOf,
    modelInputOf,
    modelDraftsOf,
    inputOverrideOf,
    emptyEffortSelection,
    effortSelectionFor,
    effortSelectionEqual,
    unknownEffortKeysOf,
    hasUnknownEffortKeys,
    selectedLevelsOf,
    reasoningDiffLines,
    applyEffortSelection,
    normalizeEffortsEntry,
    createModelRow,
    inputSelectionFor,
    patchModelDraft,
    setModelEffortSelection,
    setModelInputSelection,
    removeModelRow,
    appendModelRow,
    parseCapacity,
    formatCapacity,
    validateModelRows,
    normalizeModelRows,
    pathOps,
    hasOps,
    revisionConflictOf,
    createEditorBaseline,
    isOverridden,
    inheritedModelsOf,
    materializeOverrideOps,
    restoreDefaultOps,
    modelCatalogOps,
    providerSubtreeOps,
    importNamespace,
    catalogOpsFor,
    modelCardApply,
    providerListSections,
    apiKeyField,
    buildModelCardModel,
    createCardSession,
    modelEditableProfileOf,
    EDITABLE_PROFILE_FIELDS,
    buildSectionModel,
    ROUTE_ID_PATTERN,
    BASE_URL_FALLBACK_PATTERN,
    validateRouteId,
    validateBaseUrl,
    validateProtocol,
    validateCustomProviderDraft,
    createCustomProviderDraft,
    canCreateCustomProvider,
    buildCustomCardModel,
    modelOverrideDecision,
    modelChoicesOf,
    indexModelsById,
    adoptModels,
    joinProviderDirectory,
    providerEditable,
    providerRemovable,
    providerProfileOf,
    apiKeyEnvOf,
    credentialRefOf,
    protocolChoices,
    createSchemaAdapter,
    namespaceSchemaInfo,
    validateProfileDraft,
    rolesAffectedByChange,
    reasoningGuardMessage,
    removedLevelsOf,
    namespaceViewOf,
    roleDefaultsOf,
  });

  global[SYMBOL] = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* source: client-freshness.js */
/* classic 投影：来自源文件的机械导出改写，权威实现仍是 client-freshness.js。 */
(function installClientFreshness(global) {
"use strict";
/**
 * Client 共享边界（浏览器安全的纯 ES 模块）。
 *
 * 这里保存 Client 双面共用的三组纯逻辑，不引用 React、DOM、cordis 或任何 Node API：
 * - freshness boundary：统一 session epoch、请求序列、settings revision、catalog
 *   generation 与 fan-out cursor，只保存 JSON 兼容快照，不发请求、不渲染；
 * - RPC 归一：把 DSH Connection envelope 与同源 fetch 归一成同一种 fetch-like
 *   Response，错误 code/status/details 在两条传输上完全一致；
 * - settings 提交：动态校验后的提交与本地 revision 辅助同步。
 *
 * client.js 是 DSH 的 classic bundle（`window.__ModuleLoader__.load({ id, factory })`），
 * 不能使用 ESM import；因此它通过下面的 descriptor 契约把本模块登记到同一个
 * ModuleLoader 表里，测试与面板共用同一份实现，不再复制逻辑：
 *
 *   globalThis.__ModuleLoader__.load(__DEG_CLIENT_FRESHNESS_DESCRIPTOR__);
 *
 * descriptor.factory 是同步的（DSH 的 require 只做同步 materialize），只依赖
 * globalThis，因此加载顺序不影响它。
 *
 * ## 权威实现与发布装载路径
 *
 * 本文件是 freshness/RPC 的**唯一权威实现**，两条装载路径共用同一份源码：
 * 1. 测试与相邻模块直接 `import` 本模块（ESM）；
 * 2. 发布 bundle 由 `scripts/assemble-client.mjs` 在构建期把本文件**投影**成 classic 片段
 *    （行首 `export ` 前缀去掉 + 追加"检查点 + ModuleLoader 登记"尾部），排在唯一
 *    descriptor 之前执行；因此真实 Host 上一定会登记 `__DEG_CLIENT_FRESHNESS_DESCRIPTOR__`，
 *    client.js 的 `require("dsh-expert-group/client-freshness")` 命中同一张模块表并取回它。
 *
 * client.js 里的同名内联实现只是"宿主没有该模块"（旧 Host、缓存里的旧页面）的兼容
 * fallback，不再是无验证的手工副本：构建期差分（`probeFreshnessFace`，见
 * scripts/assemble-client.mjs）与 test/client-shared-boundary.test.mjs 会逐项比较
 * 权威实现、投影片段与内联 fallback，任何漂移都会让 `pnpm build` / `pnpm test` 失败。
 */

/** 与 client.js 共用的模块 id：必须与 descriptor.id 完全一致。 */
const CLIENT_FRESHNESS_MODULE_ID = "dsh-expert-group/client-freshness";

/**
 * classic 投影片段发布同一份导出面用的 globalThis Symbol 键（与相邻侧车模块的
 * `Symbol.for("dsh-expert-group/<name>")` 约定一致；字符串与模块 id 相同是刻意的，
 * 两者分别是模块表键与符号表键，不共享命名空间）。
 * 测试据此证明真实 bundle 装载的是本文件的实现，而不是 client.js 的内联副本。
 */
const CLIENT_FRESHNESS_GLOBAL_KEY = "dsh-expert-group/client-freshness";

/**
 * RPC 错误 code -> HTTP-ish status。settings 冲突必须是 409（客户端据此刷新并
 * 保留 dirty 草稿），会话缺失是 404，认证/通道问题是 403，取消是 499。
 * @param {object} [error]
 * @returns {number}
 */
function rpcErrorStatus(error) {
  const code = error?.code;
  if (code === "settings-conflict") return 409;
  if (code === "not-found" || code === "session-not-found") return 404;
  if (code === "forbidden" || code === "connection-required") return 403;
  if (code === "gateway/cancelled") return 499;
  if (code === "bad-request") return 400;
  return 500;
}

/**
 * 将 Connection envelope 归一为 fetch-like Response，保持两条传输的错误字段一致。
 * @param {object} [result] - { ok, value, error, status }。
 */
function normalizePluginRpcResult(result) {
  const ok = result?.ok === true;
  const payload = ok ? result.value : { ok: false, error: result?.error };
  const status = ok ? 200 : (Number.isSafeInteger(result?.status) && result.status > 0 ? result.status : rpcErrorStatus(result?.error));
  return {
    ok,
    status,
    async json() { return payload; },
  };
}

/**
 * 优先使用 DSH Connection 的独立插件 channel，认证和 envelope 由 Connection 统一处理；
 * 没有新 Connection 的旧 Host 才回落到同源 fetch，保持历史客户端可用。
 *
 * @param {object} connection - ctx.connection（可选）。
 * @param {object} request - RPC body。
 * @param {object} [init] - fetch init（signal/credentials/headers 等）。
 * @param {Function} [fetchImpl] - fetch 实现，默认 globalThis.fetch。
 * @param {{path:string, channel:string, endpoint:string}} rpcTarget - 路由常量。
 */
async function requestPluginRpc(connection, request, init = {}, fetchImpl = globalThis.fetch, rpcTarget) {
  const rpc = connection?.rpc;
  if (typeof rpc?.call === "function") {
    const result = await rpc.call(rpcTarget.channel, rpcTarget.endpoint, request, init.signal);
    return normalizePluginRpcResult(result);
  }
  if (typeof fetchImpl !== "function") throw new Error("当前 DSH 不支持插件 RPC");
  return fetchImpl(rpcTarget.path, {
    ...init,
    method: init.method ?? "POST",
    credentials: init.credentials ?? "same-origin",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ?? JSON.stringify(request),
  });
}

/**
 * Client 双面共享的 freshness seam：统一 session epoch、请求序列、settings revision、
 * catalog generation 和 fan-out cursor。它只保存 JSON 兼容快照，不渲染、不发请求；
 * 所有迟到响应必须先通过对应 accept 方法，卸载后不会再通知调用方。
 */
function createClientFreshnessBoundary({ sessionId = "", onUpdate } = {}) {
  let disposed = false;
  let currentSessionId = typeof sessionId === "string" ? sessionId : "";
  let sessionEpoch = 0;
  let sequence = 0;
  let notify = typeof onUpdate === "function" ? onUpdate : null;
  const latestRequests = new Map();
  let settings = { revision: -1, value: undefined };
  let catalog = { generation: -1, value: undefined };
  let fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };

  const requestKey = (kind, key = "") => String(kind) + "\u0000" + String(key ?? "");
  const isObject = (value) => value !== null && typeof value === "object";
  const safeRevision = (value) => Number.isSafeInteger(value) && value >= 0;
  const result = (accepted, reason, state) => ({ accepted, reason, ...(state === undefined ? {} : { state }) });
  const emit = (kind, state) => {
    if (disposed || notify === null) return;
    try { notify({ kind, state }); } catch { /* UI 订阅者异常不能破坏响应判定。 */ }
  };
  const tokenIsCurrent = (token) => {
    if (disposed) return false;
    if (token === undefined) return true;
    if (!isObject(token)) return false;
    if (token.epoch !== sessionEpoch || token.sessionId !== currentSessionId) return false;
    return latestRequests.get(token.key) === token.sequence;
  };

  const api = {
    beginSession(nextSessionId = "") {
      if (disposed) return Object.freeze({ accepted: false, reason: "disposed", sessionId: currentSessionId, epoch: sessionEpoch });
      currentSessionId = typeof nextSessionId === "string" ? nextSessionId : "";
      sessionEpoch += 1;
      sequence += 1;
      latestRequests.clear();
      fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };
      return Object.freeze({ accepted: true, sessionId: currentSessionId, epoch: sessionEpoch, sequence });
    },
    beginRequest(kind, key = "") {
      if (disposed) return Object.freeze({ accepted: false, reason: "disposed", kind, key, sessionId: currentSessionId, epoch: sessionEpoch, sequence });
      const normalizedKey = requestKey(kind, key);
      const token = { accepted: true, kind, key: normalizedKey, sessionId: currentSessionId, epoch: sessionEpoch, sequence: ++sequence };
      latestRequests.set(normalizedKey, token.sequence);
      return Object.freeze(token);
    },
    isCurrent(token) {
      return tokenIsCurrent(token);
    },
    isSessionCurrent(token) {
      return !disposed && isObject(token) && token.epoch === sessionEpoch && token.sessionId === currentSessionId;
    },
    acceptSettingsSnapshot({ revision, value, requestToken } = {}) {
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", settings);
      if (!safeRevision(revision)) return result(false, "invalid-revision", settings);
      if (revision < settings.revision) return result(false, "stale-revision", settings);
      if (revision === settings.revision && settings.value !== undefined) return result(false, "duplicate", settings);
      settings = { revision, value };
      emit("settings", settings);
      return result(true, undefined, settings);
    },
    acceptCatalogResponse({ generation, groups, value, requestToken } = {}) {
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", catalog);
      if (!safeRevision(generation)) return result(false, "invalid-generation", catalog);
      if (generation < catalog.generation) return result(false, "stale-generation", catalog);
      if (generation === catalog.generation && catalog.value !== undefined) return result(false, "duplicate", catalog);
      catalog = { generation, value: value === undefined ? groups : value };
      emit("catalog", catalog);
      return result(true, undefined, catalog);
    },
    acceptFanoutSnapshot({ sessionId: incomingSessionId, generation, cursor, snapshot, requestToken } = {}) {
      if (incomingSessionId !== currentSessionId) return result(false, "stale-session", fanout);
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", fanout);
      if (!safeRevision(generation)) return result(false, "invalid-generation", fanout);
      if (!safeRevision(cursor)) return result(false, "invalid-cursor", fanout);
      if (generation < fanout.generation) return result(false, "stale-generation", fanout);
      if (cursor < fanout.cursor) return result(false, "stale-cursor", fanout);
      if (generation === fanout.generation && cursor === fanout.cursor && fanout.snapshot !== undefined) return result(false, "duplicate", fanout);
      fanout = { sessionId: currentSessionId, generation, cursor, snapshot };
      emit("fanout", fanout);
      return result(true, undefined, fanout);
    },
    acceptFanoutEvents({ sessionId: incomingSessionId, generation, cursor, events, snapshot, requestToken } = {}) {
      return api.acceptFanoutSnapshot({
        sessionId: incomingSessionId,
        generation,
        cursor,
        snapshot: snapshot === undefined ? events : snapshot,
        requestToken,
      });
    },
    acceptFanoutAction({ sessionId: incomingSessionId, generation, requestToken } = {}) {
      if (incomingSessionId !== currentSessionId) return result(false, "stale-session");
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request");
      if (generation !== undefined && (!safeRevision(generation) || generation < fanout.generation)) return result(false, "stale-generation");
      return result(true, undefined, fanout);
    },
    snapshot() {
      return {
        disposed,
        sessionId: currentSessionId,
        epoch: sessionEpoch,
        settings,
        catalog,
        fanout,
      };
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      latestRequests.clear();
      notify = null;
      settings = { revision: -1, value: undefined };
      catalog = { generation: -1, value: undefined };
      fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };
      return true;
    },
  };
  return Object.freeze(api);
}

/**
 * 通过 Host 动态校验并提交完整 settings 候选，失败时不改变本地 dirty 草稿。
 *
 * @param {object} settings - 完整候选值。
 * @param {number} revision - 本地观察到的 settings revision。
 * @param {object} deps
 * @param {Function} [deps.request] - legacy fetch 实现。
 * @param {object} [deps.connection] - ctx.connection。
 * @param {Function} deps.normalizeSettingsDraft - 候选归一（由 client.js 注入，依赖角色表）。
 * @param {Array<string>} deps.roles - 启用的角色 id。
 * @param {{path:string, channel:string, endpoint:string}} deps.rpcTarget - RPC 路由常量。
 */
async function commitSettingsCandidate(settings, revision, { request = globalThis.fetch, connection, normalizeSettingsDraft, roles, rpcTarget } = {}) {
  const body = { action: "settings-commit", settings, expectedRevision: revision };
  const response = typeof connection?.rpc?.call === "function"
    ? await requestPluginRpc(connection, body, {}, globalThis.fetch, rpcTarget)
    : await request(rpcTarget.path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // settings 冲突必须把 Host 的权威 revision 暴露给调用方：客户端据此只推进本地
  // revision，同时保留 dirty 草稿；缺失该字段时退回 payload.revision 兼容旧 Host。
  return readSettingsCommitOutcome(response, normalizeSettingsDraft, roles);
}

/**
 * 解析 settings 提交响应：成功返回归一后的 settings 与 Host 权威 revision；
 * 失败抛出结构化错误（code/status/currentRevision），调用方据此保留 dirty 草稿。
 * currentRevision 依次取 error.details.revision、error.details.currentRevision、
 * payload.revision，兼容只回传其中之一的 Host 版本。
 *
 * @param {object} response - fetch-like Response（Connection 归一结果或真实 fetch）。
 * @param {Function} normalizeDraft - 候选归一函数（由 client.js 注入角色表）。
 * @param {Array<string>} roles - 启用的角色 id。
 */
async function readSettingsCommitOutcome(response, normalizeDraft, roles) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("设置保存响应无效");
  }
  if (!response.ok || payload?.ok !== true) {
    const issue = payload?.error && typeof payload.error === "object" ? payload.error : {};
    const message = issue.message ?? payload?.message;
    const error = new Error(typeof message === "string" ? message : "设置保存失败");
    if (typeof issue.code === "string") error.code = issue.code;
    if (Number.isSafeInteger(response.status) && response.status > 0) error.status = response.status;
    const currentRevision = issue.details?.revision ?? issue.details?.currentRevision ?? payload?.revision;
    if (Number.isSafeInteger(currentRevision) && currentRevision >= 0) error.currentRevision = currentRevision;
    throw error;
  }
  if (!payload.settings || typeof payload.settings !== "object" || Array.isArray(payload.settings)
    || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new Error("设置保存响应无效");
  }
  const rolePrompts = payload.rolePrompts !== null && typeof payload.rolePrompts === "object"
    && !Array.isArray(payload.rolePrompts)
    ? payload.rolePrompts
    : void 0;
  return {
    settings: normalizeDraft(payload.settings, roles),
    revision: payload.revision,
    ...(rolePrompts === void 0 ? {} : { rolePrompts }),
  };
}

/**
 * classic bundle 登记用 descriptor：client.js 把它交给 `window.__ModuleLoader__.load`。
 * factory 同步且无参数依赖，加载顺序不影响结果。
 */
const __DEG_CLIENT_FRESHNESS_DESCRIPTOR__ = Object.freeze({
  id: CLIENT_FRESHNESS_MODULE_ID,
  factory: () => Object.freeze({
    createClientFreshnessBoundary,
    rpcErrorStatus,
    normalizePluginRpcResult,
    requestPluginRpc,
    commitSettingsCandidate,
    readSettingsCommitOutcome,
    // client.js 通过本字段把 descriptor 登记回同一张表（见 registerClientFreshnessModule）。
    registerClientFreshnessModule,
  }),
});

/**
 * 已登记加载器的记账键。挂在当前 realm 的 globalThis 上而不是模块作用域里：
 * DSH 的 `ClientModuleSystem.register` 对同一个 id 是**抛错**语义
 * （`duplicate factory registration`），而 HMR 只失效主插件 id 后会重新执行同一份
 * bundle（投影片段也会再跑一次），所以"每个加载器实例只登记一次"必须跨执行共享。
 * 副作用是可用性权衡：freshness 源改动在 HMR 期间保持旧模块记录，整页刷新才更新。
 */
const REGISTERED_LOADERS_KEY = Symbol.for("dsh-expert-group/client-freshness#registered-loaders");

/**
 * 取当前 realm 的"已登记加载器"弱集合。用鸭子类型判断而不是 `instanceof`，
 * 避免跨 realm（vm / iframe / 测试替身）时误判并重新登记。
 */
function registeredLoaderSet(host) {
  const existing = host?.[REGISTERED_LOADERS_KEY];
  if (existing !== null && typeof existing === "object"
    && typeof existing.has === "function" && typeof existing.add === "function" && typeof existing.delete === "function") {
    return existing;
  }
  try {
    // 不枚举、不参与序列化：只是本 realm 的装载记账。
    const created = new WeakSet();
    Object.defineProperty(host, REGISTERED_LOADERS_KEY, { value: created, configurable: true, writable: true });
    return created;
  } catch {
    // globalThis 被冻结/受限时退回"不记账"的旧行为：宁可重复登记交给宿主判定，也不阻断装载。
    return null;
  }
}

/**
 * client.js 的 ModuleLoader adapter：在 bundle 内把本模块登记进同一个模块表。
 * 没有可用加载器或该加载器已登记过时静默跳过（宿主对重复 id 会抛错）。
 *
 * @param {object} [loader] - DSH 的 `window.__ModuleLoader__` 门面。
 * @returns {boolean} 本次是否执行了登记。
 */
function registerClientFreshnessModule(loader = globalThis.__ModuleLoader__) {
  if (loader === null || typeof loader !== "object" || typeof loader.load !== "function") return false;
  const registered = registeredLoaderSet(globalThis);
  if (registered !== null && registered.has(loader)) return false;
  if (registered !== null) registered.add(loader);
  try {
    loader.load(__DEG_CLIENT_FRESHNESS_DESCRIPTOR__);
  } catch (error) {
    // 登记失败必须回滚记账：否则下一次执行会误判成"已登记"而永久放弃装载。
    if (registered !== null) registered.delete(loader);
    throw error;
  }
  return true;
}

/** 投影尾部（构建期生成）：公开检查点 + ModuleLoader 登记。 */
global[Symbol.for(CLIENT_FRESHNESS_GLOBAL_KEY)] = __DEG_CLIENT_FRESHNESS_DESCRIPTOR__.factory();
registerClientFreshnessModule(global.__ModuleLoader__);
})(globalThis);

/* source: client.js */
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

    // ── 设置页样式：仅保留 dsh-expert-group settings section 使用的规则。
    const css = "" +
      ".deg_settings{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary)}" +
      ".deg_settings_title{font-size:20px;font-weight:600;line-height:28px;margin:0}" +
      ".deg_settings_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}" +
      ".deg_settings_row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,280px);align-items:center;gap:20px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".deg_settings_management_row{grid-template-columns:minmax(0,1fr) auto minmax(180px,280px)}" +
      ".deg_settings_management_row>.deg_settings_checkbox{white-space:nowrap}" +
      ".deg_settings_management_row>.deg_settings_control{justify-self:end}" +
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
      ".deg_prompt_readonly{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
      ".deg_prompt_readonly strong{display:block;margin-bottom:4px;color:var(--dsw-alias-label-primary);font-weight:600}" +
      ".deg_prompt_readonly p{margin:0}" +
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
      // 通知设置是紧凑工具条：标签不换行，停留时间选择器固定宽度，音量组吸收剩余空间。
      ".deg_settings_notification_row{display:flex;align-items:center;gap:16px;min-width:0;white-space:nowrap}" +
      ".deg_settings_notification_row>.deg_settings_checkbox{flex:0 0 auto}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(2){flex:0 0 auto}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(2) .deg_settings_label{white-space:nowrap}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(2) select{flex:0 0 74px;width:74px}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(3){flex:1 1 auto;min-width:0}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(3) .deg_settings_label{flex:0 0 auto;white-space:nowrap}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(3) input[type=range]{flex:1 1 auto;min-width:48px}" +
      ".deg_settings_notification_row>.deg_settings_control:nth-child(3) input[type=number]{flex:0 0 72px;width:72px}" +
      "@media (max-width:520px){.deg_settings_notification_row{flex-wrap:wrap;row-gap:12px}.deg_settings_notification_row>.deg_settings_control:nth-child(3){flex-basis:100%}}" +
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
       "[data-deg-settings-nav-icon]{flex:none}";


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
     * 原生运行状态文案里唯一可替换的精确子串。
     *
     * DSH 0.2.0-rc1 在输入区上方渲染宿主自己的运行状态行，中文 locale 的可见文案形如
     * 「深度求索中，用时8分12秒...」（前面还可能挂着鲸鱼尾巴节点与独立的 aria-hidden 计时器）。
     * 插件只拥有这一段前缀：替换它就能把当前会话的角色投影到宿主原生行上，而逗号、用时、
     * 末尾省略号以及前后兄弟节点/动画全部保持宿主原样——既不重建整行，也不创建覆盖层。
     */
    const NATIVE_RUNNING_STATUS_PREFIX = "深度求索中";

    /**
     * 只替换原生运行前缀的纯函数（fail-closed）。本实现与 shared.js 的同名导出语义同步
     * （classic bundle 无法 import ESM 权威实现，两处只允许逐字保持同一份语义）。
     *
     * 边界语义：
     * - 原文里没有该精确子串时返回 null：调用方必须保持宿主原文案，绝不猜测或整行重建；
     * - 只替换**第一处**出现，其余内容逐字节保留（分隔逗号、用时、末尾省略号、空白与大小写）；
     * - 原文或替换文案不是非空字符串时返回 null。
     * @param {unknown} currentText - 宿主当前渲染的原生文案。
     * @param {unknown} replacementText - 角色文案（例如 "Explorer running"，不带省略号）。
     * @returns {string|null} 替换后的完整文案；没有可替换前缀时返回 null。
     */
    function replaceNativeStatusPrefix(currentText, replacementText) {
      if (typeof currentText !== "string" || currentText.length === 0) return null;
      if (typeof replacementText !== "string" || replacementText.length === 0) return null;
      const at = currentText.indexOf(NATIVE_RUNNING_STATUS_PREFIX);
      if (at === -1) return null;
      return currentText.slice(0, at) + replacementText + currentText.slice(at + NATIVE_RUNNING_STATUS_PREFIX.length);
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
    const SETTINGS_NO_PROVIDER_LABEL = "无";

    // 提示词入口始终使用完整角色表，与模型配置的 activeRoles 读取路径刻意分离；
    // 因此 Observer 未启用时仍可配置提示词，但不会参与统一 provider 选择。
    const PROMPT_ROLE_IDS = SETTINGS_ROLE_IDS;
    const DEFAULT_PROMPT_MAX_GRAPHEMES = 32000;
    const PROMPT_WARNING_RATIO = 0.9;
    const PROMPT_DISCIPLINE_HINT = "固定执行纪律由插件在运行时自动追加且不可编辑，包含叶子 worker、工具与权限边界、continuable child 约束、交付协议和中文输出要求。";

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

    /** 只从 settings 快照保留已知角色的字符串覆盖，避免脏 wire 数据进入编辑器。 */
    function normalizePromptOverrides(value, maxGraphemes = DEFAULT_PROMPT_MAX_GRAPHEMES) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
      const normalized = {};
      for (const role of PROMPT_ROLE_IDS) {
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
    function normalizeRolePromptProjection(projection, settingsValue, snapshotOverridesAuthoritative = false) {
      if (projection === null || typeof projection !== "object" || Array.isArray(projection)
        || !Array.isArray(projection.entries)) return null;
      const fallbackOverrides = normalizePromptOverrides(settingsValue?.promptOverrides, projection.maxGraphemes);
      const settingsHasOverrides = settingsValue !== null && typeof settingsValue === "object"
        && Object.prototype.hasOwnProperty.call(settingsValue, "promptOverrides");
      // 纯函数两参数调用保留旧 Host 投影语义；只有设置组件在接收到完整 snapshot
      // 后显式启用该开关，才让空映射表达“覆盖已被删除”，以抵抗滞后的 meta 响应。
      const byRole = new Map(projection.entries
        .filter((entry) => entry && typeof entry.role === "string")
        .map((entry) => [entry.role, entry]));
      const entries = [];
      for (const role of PROMPT_ROLE_IDS) {
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
        roles: PROMPT_ROLE_IDS,
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
     */
    function settingsRolesForProvider(roles) {
      const candidates = Array.isArray(roles) ? roles : SETTINGS_REQUIRED_ROLE_IDS;
      return [...new Set(candidates.filter((role) => SETTINGS_ROLE_IDS.includes(role)))];
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

    const NOTIFICATION_HOLD_OPTIONS = Object.freeze([
      { value: 5000, label: "5s" },
      { value: 10000, label: "10s" },
      { value: 30000, label: "30s" },
      { value: 60000, label: "60s" },
      { value: 300000, label: "5min" },
      { value: 600000, label: "10min" },
      { value: 0, label: "永久" },
    ]);
    const DEFAULT_NOTIFICATION_HOLD_MS = 5000;

    /** 设置页只允许固定时长；旧配置或非法值回退到 5 秒。 */
    function notificationHoldMsOf(value) {
      const number = typeof value === "number" ? value : NaN;
      return NOTIFICATION_HOLD_OPTIONS.some((option) => option.value === number) ? number : DEFAULT_NOTIFICATION_HOLD_MS;
    }

    function clampNotificationVolume(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 100;
    }

    /** 共享每个 role 的 running shard 上限只接受 1~64 的整数，旧配置或非法值回退到 10。 */
    function normalizeRoleConcurrencyLimit(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= 64 ? value : 10;
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
        notificationHoldMs: notificationHoldMsOf(source.notificationHoldMs),
        roleConcurrencyLimit: normalizeRoleConcurrencyLimit(source.roleConcurrencyLimit),
        // 旧客户端/Host 缺少字段时保持关闭，避免升级后改变图片路由。
        observerPreferred: source.observerPreferred === true,
        // 任务管理缺字段时保持开启：默认必须维持 Expert Group 注册到侧边栏的历史行为。
        taskManagementEnabled: source.taskManagementEnabled !== false,
        // 自动打开缺字段/非法值时一律按关闭归一：默认不做任何自动 open/close。
        autoOpenSubagentSidebar: source.autoOpenSubagentSidebar === true,
      };
    }

    function settingsDraftEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
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
     */
    async function commitSettingsCandidate(settings, revision, request = globalThis.fetch, connection, roles) {
      return requireFreshnessSurface().commitSettingsCandidate(settings, revision, {
        request,
        connection,
        normalizeSettingsDraft: normalizeSettingsCommitDraft,
        roles,
        rpcTarget: RPC_TARGET,
      });
    }

    /**
     * 宿主 meta 只读读取（生命周期一次 + 用户显式刷新）。
     *
     * 角色表、能力矩阵与运行时诊断共用同一次请求：诊断面因此**不新增任何 RPC、
     * 定时器或轮询**，也不会因为打开设置页而触碰通知权限或专家任务。
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

    /** 从 meta 投影出启用角色；meta 缺失/不可用时沿用历史默认角色表。 */
    function useEnabledSettingsRoles(hostMeta) {
      return react.useMemo(() => {
        const configuredRoles = Array.isArray(hostMeta?.activeRoles) ? hostMeta.activeRoles : hostMeta?.roles;
        if (!Array.isArray(configuredRoles)) return SETTINGS_REQUIRED_ROLE_IDS;
        const enabled = configuredRoles.filter((role) => SETTINGS_ROLE_IDS.includes(role));
        if (hostMeta?.enableObserver === true && !enabled.includes("observer")) enabled.push("observer");
        return enabled.filter((role, index) => enabled.indexOf(role) === index);
      }, [hostMeta]);
    }

    // ── 客户端能力矩阵与只读诊断 ──────────────────────────────────────────
    /**
     * 诊断状态枚举白名单：宿主或客户端返回任何越界值都归一为 unknown，绝不原样回显。
     * unknown 表示"无法证明能力可用"，与 absent 一样按不可用处理（fail-closed）。
     */
    const DIAGNOSTIC_STATUS_VALUES = Object.freeze(["available", "degraded", "absent", "unknown"]);

    /** 诊断短标识符/状态文本允许的字符面：拒绝消息、路径、URL 与自由文本。 */
    const DIAGNOSTIC_TEXT_PATTERN = /^[A-Za-z0-9_./-]{1,48}$/;

    function diagnosticStatusOf(value) {
      return DIAGNOSTIC_STATUS_VALUES.includes(value) ? value : "unknown";
    }

    function diagnosticTextOf(value, fallback = null) {
      return typeof value === "string" && DIAGNOSTIC_TEXT_PATTERN.test(value) ? value : fallback;
    }

    function diagnosticCountOf(value) {
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    function diagnosticFlagOf(value) {
      return value === true;
    }

    /** 安全解析可选客户端服务：Cordis 未声明服务的属性读取会抛错。 */
    function readClientService(ctx, name) {
      try {
        const value = typeof ctx?.get === "function" ? ctx.get(name) : null;
        if (value) return value;
      } catch { /* 服务未安装或代理拒答。 */ }
      try {
        return ctx?.[name] ?? null;
      } catch {
        return null;
      }
    }

    /** 安全读取可选方法；读取抛错与缺失等价（都表示该能力不可用）。 */
    function readClientMethod(target, name) {
      try {
        const value = target?.[name];
        return typeof value === "function" ? value : void 0;
      } catch {
        return void 0;
      }
    }

    /**
     * 客户端能力矩阵（只读探测）。
     *
     * 只做 typeof 判定与一次安全服务解析，绝不调用业务方法、绝不注册任何 Slot、绝不请求
     * 通知权限。缺失可选 UI 能力时的语义与安装路径一致：
     * - absent：服务不存在 → 只禁用受影响能力，不重复注册、也不回退到另一种注册方式；
     * - degraded：能力存在但只满足降级路径（例如只有旧 openTabIn、没有公开 openTab）。
     */
    function describeExpertGroupClientCapabilities(ctx) {
      const better = readClientService(ctx, "betterSidebar");
      const sidebarRight = readClientService(ctx, "sidebarRight");
      const layout = readClientService(ctx, "layout");
      const slots = ctx?.slots;
      const betterOpen = better !== null && readClientMethod(better, "openTab") !== void 0;
      const nativeOpen = sidebarRight !== null && readClientMethod(sidebarRight, "openTab") !== void 0;
      const nativeLegacy = sidebarRight !== null && readClientMethod(sidebarRight, "openTabIn") !== void 0;
      const layoutAction = readClientMethod(layout, "openRightbar");
      const layoutPanels = layout !== null && readClientMethod(layout?.panels, "setRightbar") !== void 0;
      return Object.freeze([
        {
          id: "connection",
          label: "Connection RPC",
          required: true,
          status: readClientMethod(ctx?.connection?.rpc, "call") === void 0 ? "degraded" : "available",
          detail: readClientMethod(ctx?.connection?.rpc, "call") === void 0 ? "legacy-http" : "connection-rpc",
        },
        {
          id: "slots",
          label: "客户端 Slot 注册",
          required: true,
          status: readClientMethod(slots, "register") !== void 0 && readClientMethod(slots, "inject") !== void 0
            ? "available"
            : "absent",
          detail: "settings-and-overlay",
        },
        {
          id: "betterSidebar",
          label: "better-sidebar 页面",
          required: false,
          status: better === null ? "absent" : betterOpen ? "available" : "degraded",
          detail: better === null ? "not-installed-no-native-fallback" : betterOpen ? "openTab" : "openTab-missing",
        },
        {
          id: "nativeSidebar",
          label: "原生右侧栏",
          required: false,
          status: nativeOpen ? "available" : nativeLegacy ? "degraded" : "absent",
          detail: nativeOpen ? "scoped-openTab" : nativeLegacy ? "legacy-openTabIn" : "unavailable",
        },
        {
          // 公开 openTab 接缝是 ticket 08 能力矩阵的独立条目：better-sidebar 与原生右栏
          // 各自拥有一个，旧 openTabIn 只是兼容路径（因此整体状态降级而非缺失）。
          id: "openTab",
          label: "公开 openTab 接缝",
          required: false,
          status: betterOpen || nativeOpen ? "available" : nativeLegacy ? "degraded" : "absent",
          detail: betterOpen
            ? "better-sidebar-openTab"
            : nativeOpen ? "sidebarRight-openTab" : nativeLegacy ? "legacy-openTabIn" : "unavailable",
        },
        {
          id: "layout",
          label: "布局动作",
          required: false,
          status: layoutAction !== void 0 ? "available" : layoutPanels ? "degraded" : "absent",
          detail: layoutAction !== void 0 ? "openRightbar" : layoutPanels ? "panels-setRightbar-only" : "unavailable",
        },
        {
          id: "taskSidebar",
          label: "任务侧栏注册",
          required: false,
          status: typeof expertGroupSidebar?.installExpertGroupSidebar === "function" ? "available" : "absent",
          detail: "expert-group-page",
        },
      ]);
    }

    /**
     * 宿主诊断字段白名单：只按固定路径提取已声明的数值/状态字段。
     *
     * 白名单同时是敏感性边界——即使宿主或中间层返回了额外字段（prompt、路径、token…），
     * 这里也不会读取，更不会渲染。
     */
    const HOST_DIAGNOSTIC_FIELDS = Object.freeze([
      { id: "activeChildren", label: "活动专家 child", path: ["children", "active"], kind: "count" },
      { id: "trackedChildren", label: "已登记 child", path: ["children", "tracked"], kind: "count" },
      { id: "fanoutActiveParents", label: "进行中的父任务", path: ["fanout", "activeParents"], kind: "count" },
      { id: "fanoutQueuedShards", label: "fan-out 排队分片", path: ["fanout", "queuedShards"], kind: "count" },
      { id: "fanoutRunningShards", label: "fan-out 运行分片", path: ["fanout", "runningShards"], kind: "count" },
      { id: "roleConcurrencyDefault", label: "角色并发默认上限", path: ["fanout", "concurrency", "default"], kind: "count" },
      { id: "recoveryRebuilds", label: "待重建恢复", path: ["recovery", "rebuilds"], kind: "count" },
      { id: "recoveryContexts", label: "恢复上下文", path: ["recovery", "trackedContexts"], kind: "count" },
      { id: "pendingSettingsWrites", label: "在途 settings 写入", path: ["settings", "pendingWrites"], kind: "count" },
      { id: "settingsGeneration", label: "模型目录代次", path: ["settings", "generation"], kind: "count" },
      { id: "storageGeneration", label: "storage generation", path: ["storage", "generation"], kind: "count" },
      { id: "handoffPending", label: "pending admission", path: ["handoff", "pending"], kind: "count" },
      { id: "notificationRoots", label: "已登记通知根会话", path: ["notifications", "roots"], kind: "count" },
      { id: "fanoutRestorePending", label: "fan-out 待恢复", path: ["fanout", "restorePending"], kind: "flag" },
      { id: "storageStatus", label: "storage 状态", path: ["storage", "status"], kind: "token" },
    ]);

    /** 宿主能力矩阵到客户端展示面的映射（状态语义统一为 available/degraded/absent/unknown）。 */
    const HOST_CAPABILITY_FIELDS = Object.freeze([
      { key: "rootTurnWait", id: "host.rootTurnWait", label: "Root turn 等待（session-activity）" },
      { key: "connectionRpc", id: "host.connectionRpc", label: "Connection RPC 通道" },
      { key: "storageDomain", id: "host.storageDomain", label: "storage domain 绑定" },
      { key: "attachments", id: "host.attachments", label: "附件/图片规范化" },
      { key: "sessionQuery", id: "host.sessionQuery", label: "冷会话读取" },
    ]);

    /** 宿主能力状态到统一枚举的映射；无法识别一律 unknown（按不可用处理）。 */
    function hostCapabilityStatusOf(status) {
      if (status === "available" || status === "ready") return "available";
      if (status === "incomplete" || status === "degraded" || status === "fail-closed" || status === "legacy" || status === "partial") return "degraded";
      if (status === "absent" || status === "missing" || status === "none" || status === "unavailable") return "absent";
      return "unknown";
    }

    function readDiagnosticPath(source, path) {
      let current = source;
      for (const key of path) {
        if (current === null || typeof current !== "object") return void 0;
        current = current[key];
      }
      return current;
    }

    /**
     * 归一为只读诊断报告。
     *
     * 输入可以只有客户端能力（宿主 meta 不可用时），也可以是宿主完整响应；输出结构固定，
     * 所有字符串都经过字符面与长度校验，所有数值都归一为非负整数。报告是纯数据，
     * 不携带任何会话 id、agent id、prompt、原始请求体、token、Cookie 或文件系统路径。
     *
     * 客户端不再持有任何通知运行期计数：通知投递由 Host 负责（系统通知是唯一通知界面），
     * 客户端侧既没有轮询、也没有投递，因此报告里没有 client 计数块。
     *
     * @param {object} [options]
     * @param {object[]} [options.clientCapabilities] - describeExpertGroupClientCapabilities 的结果。
     * @param {object|null} [options.hostMeta] - meta 只读响应。
     */
    function describeExpertGroupDiagnostics({ clientCapabilities = [], hostMeta = null } = {}) {
      const host = hostMeta !== null && typeof hostMeta === "object" ? hostMeta : {};
      const hostCapabilities = host.capabilities !== null && typeof host.capabilities === "object" ? host.capabilities : null;
      const hostDiagnostics = host.diagnostics !== null && typeof host.diagnostics === "object" ? host.diagnostics : null;
      const capabilityEntries = [];
      const clientList = Array.isArray(clientCapabilities) ? clientCapabilities : [];
      for (const entry of clientList) {
        if (entry === null || typeof entry !== "object") continue;
        capabilityEntries.push({
          id: diagnosticTextOf(entry.id, "client.unknown"),
          label: typeof entry.label === "string" ? entry.label.slice(0, 32) : "客户端能力",
          required: diagnosticFlagOf(entry.required),
          status: diagnosticStatusOf(entry.status),
          detail: diagnosticTextOf(entry.detail, null),
          scope: "client",
        });
      }
      if (hostCapabilities !== null) {
        const hostEntries = hostCapabilities.host;
        for (const field of HOST_CAPABILITY_FIELDS) {
          const entry = hostEntries !== null && typeof hostEntries === "object" ? hostEntries[field.key] : void 0;
          if (entry === null || typeof entry !== "object") continue;
          capabilityEntries.push({
            id: field.id,
            label: field.label,
            required: diagnosticFlagOf(entry.required),
            status: hostCapabilityStatusOf(entry.status),
            // 降级说明只接受固定 token；宿主返回的自由文本一律丢弃。
            detail: diagnosticTextOf(entry.degradation, null),
            scope: "host",
          });
        }
      }
      const runtime = [];
      for (const field of HOST_DIAGNOSTIC_FIELDS) {
        const value = readDiagnosticPath(hostDiagnostics, field.path);
        if (field.kind === "flag") runtime.push({ id: field.id, label: field.label, value: diagnosticFlagOf(value), kind: "flag" });
        else if (field.kind === "token") runtime.push({ id: field.id, label: field.label, value: diagnosticTextOf(value, "none"), kind: "token" });
        else runtime.push({ id: field.id, label: field.label, value: diagnosticCountOf(value), kind: "count" });
      }
      // 角色级并发上限：角色名是公开契约；其它键与非法值一律丢弃。
      const roleLimits = readDiagnosticPath(hostDiagnostics, ["fanout", "concurrency", "roles"]);
      const roleEntries = [];
      if (roleLimits !== null && typeof roleLimits === "object" && !Array.isArray(roleLimits)) {
        for (const role of Object.keys(roleLimits).sort()) {
          if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(role)) continue;
          if (!Number.isSafeInteger(roleLimits[role])) continue;
          roleEntries.push({ id: "roleLimit." + role, label: role + " 并发上限", value: roleLimits[role], kind: "count" });
        }
      }
      // RPC 错误类别：只有结构化 code 与次数，没有消息、请求体或路径。
      const recentErrors = readDiagnosticPath(hostDiagnostics, ["rpc", "recentErrors"]);
      const rpcErrors = [];
      if (Array.isArray(recentErrors)) {
        for (const entry of recentErrors.slice(0, 8)) {
          const code = diagnosticTextOf(entry?.code, null);
          if (code === null) continue;
          rpcErrors.push({ code, count: diagnosticCountOf(entry?.count) });
        }
      }
      return Object.freeze({
        version: 1,
        hostAvailable: hostDiagnostics !== null,
        capabilities: Object.freeze(capabilityEntries.map((entry) => Object.freeze(entry))),
        runtime: Object.freeze([...runtime, ...roleEntries].map((entry) => Object.freeze(entry))),
        rpcErrors: Object.freeze(rpcErrors.map((entry) => Object.freeze(entry)))
      });
    }

    /** 单条能力矩阵行（只读展示；data 属性同时作为诊断契约供测试与维护者读取）。 */
    function renderDiagnosticCapability(entry) {
      return react.createElement("div", {
        key: entry.id,
        className: "deg_settings_diagnostic_row",
        "data-deg-capability": entry.id,
        "data-deg-status": entry.status,
        "data-deg-required": entry.required ? "true" : "false",
        "data-deg-scope": entry.scope,
      },
        react.createElement("span", { className: "deg_settings_diagnostic_label" }, entry.label + (entry.required ? "（必需）" : "")),
        react.createElement("span", { className: "deg_settings_diagnostic_value" },
          entry.detail === null ? entry.status : entry.status + " · " + entry.detail));
    }

    /** 单条运行时诊断行；kind 只影响展示格式，值早已按白名单归一。 */
    function renderDiagnosticRuntime(entry) {
      const value = entry.kind === "flag" ? (entry.value === true ? "是" : "否") : String(entry.value);
      return react.createElement("div", {
        key: entry.id,
        className: "deg_settings_diagnostic_row",
        "data-deg-diagnostic": entry.id,
        "data-deg-value": value,
      },
        react.createElement("span", { className: "deg_settings_diagnostic_label" }, entry.label),
        react.createElement("span", { className: "deg_settings_diagnostic_value" }, value));
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
    function DshExpertGroupSettings({ settingsForm, modelCatalog, modelConfigHost, ctx, diagnostics }) {
      const subscribe = react.useMemo(() => settingsForm.subscribe.bind(settingsForm), [settingsForm]);
      const getSnapshot = react.useMemo(() => settingsForm.getSnapshot.bind(settingsForm), [settingsForm]);
      const settingsSnapshot = react.useSyncExternalStore(subscribe, getSnapshot);
      const catalogSubscribe = react.useMemo(() => modelCatalog.subscribe.bind(modelCatalog), [modelCatalog]);
      const catalogGetSnapshot = react.useMemo(() => modelCatalog.getSnapshot.bind(modelCatalog), [modelCatalog]);
      const directoryState = react.useSyncExternalStore(catalogSubscribe, catalogGetSnapshot);
      // 宿主 meta 同时提供角色表、能力矩阵与运行时诊断；读取失败时不显示诊断块。
      const [hostMeta, refreshHostMeta, hostMetaError] = useHostMeta(ctx);
      const roles = useEnabledSettingsRoles(hostMeta);
      const hostPromptProjection = react.useMemo(
        () => normalizeRolePromptProjection(hostMeta?.rolePrompts, settingsSnapshot.value, true),
        [hostMeta, settingsSnapshot.value],
      );
      react.useEffect(() => {
        void modelCatalog.load();
      }, [modelCatalog]);
      const [draft, setDraft] = react.useState(() => normalizeSettingsDraft(settingsSnapshot.value, roles));
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
      const sourcePromptOverrides = normalizePromptOverrides(settingsSnapshot.value?.promptOverrides, promptMaxGraphemes);
      const promptTouchedRoles = Object.keys(promptTouched).filter((role) => PROMPT_ROLE_IDS.includes(role));
      const promptDirty = baselineProjection !== null && PROMPT_ROLE_IDS.some((role) => {
        if (!Object.prototype.hasOwnProperty.call(promptTouched, role)) return false;
        const entry = promptEntryOf(baselineProjection, role);
        return entry !== null && promptTextOf(role) !== entry.effective;
      });
      // 共享一个 saved dirty 判定：模型/通知的既有草稿与提示词草稿可以独立变回基线，
      // 不把“曾经编辑过”误判为仍需提交，也不影响任务管理等历史控件的保存语义。
      const settingsDirty = !settingsDraftEqual(
        normalizeSettingsDraft(draft, roles, false),
        normalizeSettingsDraft(settingsSnapshot.value, roles, false),
      );
      const hasUnsavedChanges = settingsDirty || promptDirty;
      // 编辑器内没有模型/通知控件；外部 snapshot 造成的列表草稿差异不应被误判为
      // 当前提示词的本地修改，否则干净编辑器无法自动刷新。
      const editorHasUnsavedChanges = selectedPromptRole === null ? hasUnsavedChanges : promptDirty;

      react.useEffect(() => {
        if (!dirty) {
          setDraft(normalizeSettingsDraft(settingsSnapshot.value, roles));
          // 未编辑角色必须继续从 Host rolePrompts 读 effective 值；不能仅按 settings
          // snapshot 填空对象，否则无覆盖时会把默认 persona 显示成空文本。
          setPromptDrafts({});
          setPromptTouched({});
          setPromptError(null);
        }
      }, [dirty, settingsSnapshot.value, roles, promptMaxGraphemes]);

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
        if (!Number.isSafeInteger(settingsSnapshot.revision) || settingsSnapshot.revision === editorBaseline.revision) return;
        if (promptDirty) {
          // 用户实际输入优先：只提示外部版本变化，绝不覆盖文本、换行或当前校验错误。
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
      }, [selectedPromptRole, editorBaseline, localPromptProjection, settingsSnapshot.revision, settingsSnapshot.value, hostPromptProjection, promptDirty, roles]);

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
        if (!PROMPT_ROLE_IDS.includes(role)) return;
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
        const nextPromptDirty = baselineProjection !== null && PROMPT_ROLE_IDS.some((candidate) => {
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
      // 统一选择器只反映当前展示角色的共同 provider；混合状态使用空值映射到“无”。
      const unifiedProvider = unifiedProviderOf(draft.defaults, roles, draft.provider);

      const save = async ({ retry = false } = {}) => {
        const promptOnlySave = selectedPromptRole !== null && promptTouchedRoles.length > 0;
        if (!hasUnsavedChanges || saving || settingsSnapshot.writable !== true
          || (!promptOnlySave && !catalogAvailable)) return false;
        const source = normalizeSettingsDraft(settingsSnapshot.value, roles);
        // 编辑器只修改提示词时必须以当前完整 snapshot 为候选基底：首次 CAS 会因旧 revision
        // 冲突而失败；明确重试时才以最新 snapshot + 用户实际提示词字段提交，绝不重放旧模型/通知。
        const normalizedDraft = promptOnlySave ? source : normalizeSettingsDraft(draft, roles, false);
        const sourceProvider = unifiedProviderOf(source.defaults, roles, source.provider);
        const draftProviderIntent = promptOnlySave ? sourceProvider : (typeof draft.provider === "string" ? draft.provider : "");
        const draftProvider = unifiedProviderOf(normalizedDraft.defaults, roles, draftProviderIntent);
        const defaultsChanged = !settingsDraftEqual(normalizedDraft.defaults, source.defaults);
        // provider 的模型变化由 defaults 差异或用户明确改变统一选择器决定；通知字段单独保存时
        // draftProviderIntent 与 sourceProvider 相同，因此不会把旧顶层 provider 强行写回行级配置。
        // 目录门控与下拉同源（catalogAvailable）：缓存在手时用户从缓存里选出的 provider+model
        // 是合法候选，必须能随这次保存一起提交，否则就成了"能选不能存"；反之没有任何目录时
        // 这里仍然不写，绝不凭空写入一个无法校验的 provider。
        const modelChanged = !promptOnlySave && catalogAvailable && (defaultsChanged || draftProviderIntent !== sourceProvider);

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
              setPromptError((SETTINGS_ROLE_LABELS[role] ?? role) + "：" + validation.message);
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
        const sourceHasPromptOverrides = settingsSnapshot.value !== null
          && typeof settingsSnapshot.value === "object"
          && Object.prototype.hasOwnProperty.call(settingsSnapshot.value, "promptOverrides");
        const promptChanged = !promptOverridesEqual(candidatePromptOverrides, sourcePromptOverrides);
        const includePromptOverrides = sourceHasPromptOverrides || promptTouchedRoles.length > 0;
        const candidate = {
          ...normalizedDraft,
          provider: modelChanged ? draftProvider : sourceProvider,
          ...(modelChanged ? {} : { defaults: source.defaults }),
          ...(includePromptOverrides ? { promptOverrides: candidatePromptOverrides } : {}),
        };
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
        if (candidate.notificationHoldMs !== source.notificationHoldMs) {
          ops.push({ op: "set", path: ["notificationHoldMs"], value: candidate.notificationHoldMs });
        }
        if (candidate.observerPreferred !== source.observerPreferred) {
          ops.push({ op: "set", path: ["observerPreferred"], value: candidate.observerPreferred });
        }
        if (candidate.roleConcurrencyLimit !== source.roleConcurrencyLimit) {
          ops.push({ op: "set", path: ["roleConcurrencyLimit"], value: candidate.roleConcurrencyLimit });
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
        // 提示词首次提交必须保留进入编辑页时看到的 revision；实时 snapshot 只用于
        // 观察外部变化，不能被拿来绕过整体 settings 的 CAS。
        const expectedRevision = retry === true
          ? settingsSnapshot.revision
          : selectedPromptRole !== null && promptTouchedRoles.length > 0
            && Number.isSafeInteger(editorBaseline?.revision)
            ? editorBaseline.revision
            : settingsSnapshot.revision;
        setSaving(true);
        setSaved(false);
        setError(null);
        setPromptError(null);
        try {
          let accepted;
          let committed = null;
          if (ops.length > 0) {
            // 角色配置唯一写入路径：DEG 自有提交端点（Host commitSettingsCandidate 完成
            // schema、语义与 revision CAS 校验）。绝不调用配置表单的 set/unset/mutate：
            // 那会绕过 DEG 的提示词语义校验与模型目录代次检测。
            // 共享镜像会随 settings/document-updated 自行刷新，无需本地推进 revision。
            committed = await commitSettingsCandidate(candidate, expectedRevision, globalThis.fetch, ctx?.connection, roles);
            accepted = committed.settings;
          } else {
            accepted = normalizeSettingsCommitDraft(settingsForm.getSnapshot().value, roles);
          }
          // Host 已在同一提交边界完成 schema、模型和 revision 校验；200 响应中的
          // committed settings 是权威归一结果，不再与客户端草稿做易误报的 JSON 全量比较。
          const acceptedPromptOverrides = normalizePromptOverrides(
            Object.prototype.hasOwnProperty.call(accepted ?? {}, "promptOverrides")
              ? accepted.promptOverrides
              : candidatePromptOverrides,
            promptMaxGraphemes,
          );
          setDraft(accepted);
          setPromptDrafts({});
          setPromptTouched({});
          const responseProjection = normalizeRolePromptProjection(committed?.rolePrompts, accepted, true);
          let acceptedProjection = responseProjection ?? promptProjection;
          if (acceptedProjection !== null) {
            for (const role of promptTouchedRoles) {
              const entry = promptEntryOf(acceptedProjection, role);
              const text = Object.prototype.hasOwnProperty.call(acceptedPromptOverrides, role)
                ? acceptedPromptOverrides[role]
                : entry?.defaultPersona ?? promptTextOf(role);
              acceptedProjection = updateRolePromptProjection(acceptedProjection, role, text);
            }
            const committedRevision = Number.isSafeInteger(committed?.revision)
              ? committed.revision
              : settingsSnapshot.revision;
            setLocalPromptProjection({ revision: committedRevision, projection: acceptedProjection });
            if (selectedPromptRole !== null) {
              // 提交响应已经是 Host 权威状态，立即更新编辑基线；共享镜像随后自行刷新，
              // 直到更高或相等的外部 snapshot 到达后再自然让位。
              setEditorBaseline({
                role: selectedPromptRole,
                value: accepted,
                revision: committedRevision,
                projection: acceptedProjection,
              });
            }
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
        const refreshedProjection = normalizeRolePromptProjection(hostMeta?.rolePrompts, snapshot.value, true) ?? promptProjection;
        setDraft(normalizeSettingsDraft(snapshot.value, roles));
        // 重新加载时清空局部草稿，让 Host 当前 effective/default 成为编辑初值。
        setPromptDrafts({});
        setPromptTouched({});
        if (selectedPromptRole !== null && refreshedProjection !== null) {
          setEditorBaseline({
            role: selectedPromptRole,
            value: snapshot.value,
            revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null,
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
        const projection = normalizeRolePromptProjection(hostMeta?.rolePrompts, snapshot.value, true) ?? promptProjection;
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
        : (SETTINGS_ROLE_LABELS[selectedPromptRole] ?? selectedPromptRole);
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
        react.createElement("div", { className: "deg_prompt_readonly" },
          react.createElement("strong", null, "固定执行纪律"),
          react.createElement("p", null, PROMPT_DISCIPLINE_HINT)),
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
            react.createElement("button", { type: "button", className: "deg_btn deg_btn_primary", disabled: saving, onClick: retryPromptSave }, "继续使用当前提示词重试"))),
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
            disabled: !promptDirty || !promptValidation.ok || saving || settingsReadOnly || promptLoading || baselineProjection?.customizable !== true,
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
          "aria-label": "未保存的提示词修改",
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
          react.createElement("h3", null, "未保存的提示词修改"),
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
      const rows = PROMPT_ROLE_IDS.map((role) => {
        const roleEnabled = roles.includes(role);
        const selection = draft.defaults[role] ?? null;
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
            const defaults = { ...previous.defaults };
            if (!provider) {
              delete defaults[role];
            } else if (provider !== defaults[role]?.provider) {
              defaults[role] = migrateSettingsSelection(defaults[role], provider, providerGroups)
                ?? { provider, model: "" };
            }
            return { ...previous, provider: "", defaults };
          });
        };
        const updateModel = (event) => {
          const modelId = event.target.value;
          editDraft((previous) => {
            const defaults = { ...previous.defaults };
            const provider = defaults[role]?.provider ?? "";
            if (!provider) return previous;
            if (!modelId) {
              defaults[role] = { provider, model: "" };
            } else {
              const model = providerGroups.find((group) => group.id === provider)?.models?.find((candidate) => candidate.id === modelId);
              if (!model) return previous;
              const next = { provider, model: model.id };
              if (typeof model.reasoning?.defaultEffort === "string") next.reasoningEffort = model.reasoning.defaultEffort;
              defaults[role] = next;
            }
            return { ...previous, defaults };
          });
        };
        const updateReasoning = (event) => {
          editDraft((previous) => {
            const defaults = { ...previous.defaults };
            if (!defaults[role] || !defaults[role].model) return previous;
            const next = { ...defaults[role] };
            if (event.target.value) next.reasoningEffort = event.target.value;
            else delete next.reasoningEffort;
            defaults[role] = next;
            return { ...previous, defaults };
          });
        };
        return react.createElement(react.Fragment, { key: role },
          react.createElement("div", { className: "deg_settings_table_cell deg_settings_role_cell" },
            react.createElement("button", {
              type: "button",
              className: "deg_settings_role_button",
              "data-deg-prompt-role": role,
              "aria-label": (SETTINGS_ROLE_LABELS[role] ?? role) + "提示词"
                + (promptEntryOf(promptProjection, role)?.customized === true ? "（已自定义提示词）" : ""),
              "aria-pressed": selectedPromptRole === role,
              // 读取失败仍可进入错误页并重试；只有正在提交时才锁住入口，避免永久死锁。
              disabled: saving,
              onClick: (event) => openPrompt(role, event),
            },
              react.createElement("span", null, SETTINGS_ROLE_LABELS[role] ?? role),
              promptEntryOf(promptProjection, role)?.customized === true
                ? react.createElement("span", {
                  className: "deg_settings_prompt_customized_dot",
                  "aria-hidden": "true",
                })
                : null)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_provider_select",
              "aria-label": (SETTINGS_ROLE_LABELS[role] ?? role) + " 供应商",
              value: rowProvider,
              disabled: saving || !catalogAvailable || !roleEnabled,
              onChange: updateProvider,
            }, providerOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_model_select",
              "aria-label": (SETTINGS_ROLE_LABELS[role] ?? role) + " 模型选择",
              value: selection?.model ?? "",
              disabled: saving || !catalogAvailable || !roleEnabled || !rowProvider || rowProviderGroup === undefined,
              onChange: updateModel,
            }, modelOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_effort_select",
              "aria-label": (SETTINGS_ROLE_LABELS[role] ?? role) + " 思考深度",
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
          roleLabelOf: (role) => SETTINGS_ROLE_LABELS[role] ?? role,
        });
      return react.createElement("div", { className: "deg_settings" },
        react.createElement("h2", { className: "deg_settings_title" }, "dsh-expert-group"),
        react.createElement("p", { className: "deg_settings_hint" }, "专家模型使用 DSH 当前已配置的 provider 和模型目录。"),
        modelConfigSection,
        react.createElement("div", { className: "deg_settings_row deg_settings_notification_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              checked: draft.notificationEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, "通知弹窗")),
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-notification-hold" },
            react.createElement("span", { className: "deg_settings_label" }, "弹窗停留时间"),
            react.createElement("select", {
              id: "deg-settings-notification-hold",
              "aria-label": "弹窗停留时间",
              value: draft.notificationHoldMs,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationHoldMs: notificationHoldMsOf(Number(event.target.value)) })),
            }, NOTIFICATION_HOLD_OPTIONS.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)))),
          react.createElement("label", { className: "deg_settings_control" },
            react.createElement("span", { className: "deg_settings_label" }, "通知音量"),
            react.createElement("input", {
              type: "range", min: 0, max: 100, step: 1,
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            }),
            react.createElement("input", {
              type: "number", min: 0, max: 100, step: 1,
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            }))),
        react.createElement("div", { className: "deg_settings_row" },
          react.createElement("label", { className: "deg_settings_label", htmlFor: "deg-settings-provider" }, "统一供应商"),
          react.createElement("div", { className: "deg_settings_control" },
            react.createElement("select", {
              id: "deg-settings-provider",
              value: unifiedProvider,
              disabled: saving || !catalogAvailable,
              onChange: (event) => editDraft((previous) => {
                const provider = event.target.value;
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
              react.createElement("option", { value: "" }, SETTINGS_NO_PROVIDER_LABEL),
              providerGroups.map((group) => react.createElement("option", { key: group.id, value: group.id }, group.name ?? group.id))))),
        react.createElement("div", { className: "deg_settings_table_wrap" },
          react.createElement("div", { className: "deg_settings_table" }, header, rows)),
        react.createElement("div", { className: "deg_settings_row deg_settings_management_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", { type: "checkbox", "aria-label": "Observer优先", checked: draft.observerPreferred, disabled: saving, onChange: (event) => editDraft((previous) => ({ ...previous, observerPreferred: event.target.checked })) }),
            react.createElement("span", { className: "deg_settings_label" }, "Observer优先")),
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": "任务管理",
              checked: draft.taskManagementEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, taskManagementEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, "任务管理")),
          // 「Auto」= 自动打开运行中的子代理右侧栏会话：与任务管理同一行的紧凑开关。
          // 说明性文案只放在 title（悬浮提示）里，可见文字保持一个单词，不挤压既有控件。
          react.createElement("label", { className: "deg_settings_checkbox", title: "自动打开运行中的子代理侧栏会话" },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": "Auto",
              checked: draft.autoOpenSubagentSidebar,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, autoOpenSubagentSidebar: event.target.checked === true })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, "Auto")),
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-role-concurrency-limit" },
            react.createElement("span", { className: "deg_settings_label" }, "单个角色并发上限"),
            react.createElement("input", {
              id: "deg-settings-role-concurrency-limit",
              type: "number",
              "aria-label": "单个角色并发上限",
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
            }))),
        directoryState.error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, directoryState.error) : null,
        error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, error) : null,
        react.createElement("div", { className: "deg_settings_footer" },
          react.createElement("span", { className: "deg_settings_status", role: "status" }, saved ? "已保存" : hasUnsavedChanges ? "有未保存的修改" : ""),
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving, onClick: discard }, "放弃修改"),
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving || !catalogAvailable || settingsSnapshot.writable !== true, onClick: save }, saving ? "保存中…" : "保存")));
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
      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: SETTINGS_ENTRY_ID,
        order: 25,
        label: () => SETTINGS_ENTRY_ID,
        inject: () => ({ settingsForm, modelCatalog, modelConfigHost, ctx }),
      }, DshExpertGroupSettings));



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
    // 只读能力矩阵与诊断面：设置页、维护者与测试共用同一份纯函数实现。
    exports.describeExpertGroupClientCapabilities = describeExpertGroupClientCapabilities;
    exports.describeExpertGroupDiagnostics = describeExpertGroupDiagnostics;
    /**
     * 设置页导航行品牌图标（DOM 适配）的公开面：
     * - DEG_SETTINGS_NAV_ICON_PATHS / DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS：artwork 常量，
     *   测试据此断言与 client-expert-group-sidebar.js 的 BRAND_ICON_PATHS 同值；
     * - isDegSettingsNavRow：导航行的匹配纯逻辑（label 严格相等 + 含 svg）；
     * - installDegSettingsNavIcon：observer 生命周期，apply 用 ctx.effect 绑定它。
     */
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
