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
