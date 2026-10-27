/**
 * 会话删除的客户端多选状态机与 RPC 封装（票据 05）。
 *
 * ## 这个模块只做两件事
 * 1. **纯状态机**：模式开关、锁定工作区、候选分组、选中集合、结算中标记、最近一次结算结果。
 *    所有转移都是纯函数（旧状态进、新状态出），不读写 DOM、不碰 React、不做任何渲染。
 * 2. **RPC 封装**：候选查询与删除调用经注入的 `port` 走既有 `callRpc` 通道；错误归一成
 *    `{ code, kind, message }`（404/409/503/400 都有稳定 kind）。候选查询失败时**不进入模式**
 *    （规格决策 25 的 fail-closed），删除入口因此保持不可用。
 *
 * ## 为什么状态机不自己发请求
 * 渲染层（票据 06/07）要随时读同一份状态决定渲染什么；把「状态」与「一次往返」分开，
 * D6 的状态转移才能在无网络、无渲染器的前提下逐条断言。异步编排（open/submit/retry）只是
 * 「读端口 → 纯转移 → 再读端口」的薄壳，本身不含第二条真相。
 *
 * ## 计数口径（规格决策 18/24；服务端返回的候选已是冻结闭包口径）
 * - 已选 = 选中集合大小；
 * - 将处理 = 选中集合 ∩ 候选里的可处理目标（客户端只做去重与过滤，**不重算闭包**）；
 * - 被阻塞 = 候选级 blocked（live / live-descendant / pending-cleanup），不在选中集合里；
 * - absent = 可处理目标里日志已不在、只剩残留的那些，单列（确认框「仅清理残留」）。
 *
 * ## 结算后的选中集合（规格决策 20）
 * 只保留「结果仍是 failed、且候选里仍可处理」的目标：`skipped` / `raced` 移出选中
 * （用户没重新勾选就不会被再次提交），`deleted` / `absent` 的行直接消失。全部目标都是
 * deleted/absent 时自动退出多选；否则保留模式并显示结算条。手动退出（× / Esc）任何时刻都可用。
 *
 * ## 分批（服务端单次上限 200）
 * 超过上限时按 200 分批**顺序**提交并合并结果，绝不静默截断；中途失败立即停止提交后续批次
 * （同一时刻只允许一个删除作业），已完成的批次仍然并入结算——用户看到的是「真的发生了什么」，
 * 而不是「整轮什么都没发生」。
 *
 * ## 端口约定
 * `port` 是唯一的外部协作面：`{ call(request) }`（也可直接传函数）。票据 06/07 注入
 * `(request) => callRpc(deps, ctx, request)` 即可；本模块不 import 任何兄弟 IIFE 检查点，
 * 因此不增加客户端 IIFE 依赖边。
 *
 * 检查点：`globalThis[Symbol.for("dsh-expert-group/client-session-delete-selection")]`。
 * 装配顺序见 `scripts/client-source-manifest.mjs`（恒在唯一 descriptor 之前）。
 */
(function installClientSessionDeleteSelection(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-session-delete-selection");

  /** 两个 action 名：与 host/session-delete-rpc.js 的 SESSION_DELETE_ACTIONS 逐字一致。 */
  const ACTION_CANDIDATES = "session-delete-candidates";
  const ACTION_REMOVE = "session-delete";

  /**
   * 未分组范围 key：会话不属于任何工作区时，状态里用这个固定字符串表示范围。
   *
   * 工作区 ID 是宿主 UUID，不会与它冲突；**绝不用空串当哨兵**——空串在本模块里同时表示
   * 「范围未就绪 / 输入无效」，混用会让「未就绪」被误当成「可删除的未分组范围」。
   * 请求体里它翻译成 `{ scope: "ungrouped" }`（见 scopeRequestFields）。
   */
  const UNGROUPED_SCOPE = "ungrouped";

  /**
   * 服务端单次删除的目标数上限（host SESSION_DELETE_TARGETS_LIMIT = 200）。
   * 客户端必须自己分批：服务端对超限请求返回 400 delete-targets-invalid，不会静默截断。
   */
  const TARGETS_LIMIT = 200;

  /** 五态（互斥且穷尽），顺序即展示顺序：与 host/session-delete-closure.js 一致。 */
  const RESULT_STATES = Object.freeze(["deleted", "raced", "failed", "skipped", "absent"]);

  /**
   * 结果态别名：服务端当前不返回 `deletedWithWarnings`，一旦返回就按 `deleted` 处理
   * （行已消失、日志已改名进隔离区），绝不因为多了个后缀就把目标留在选中集合里。
   */
  const RESULT_STATE_ALIASES = Object.freeze({ deletedWithWarnings: "deleted" });

  /**
   * 稳定错误码 → 可展示原因类（host/session-delete-rpc.js 的 SESSION_DELETE_RPC_CODES）：
   * 404 → not-found、409 → busy、503 → unavailable、400 → invalid；没有 code 的是传输层失败。
   */
  const ERROR_KINDS = Object.freeze({
    "workspace-not-found": "not-found",
    "delete-job-busy": "busy",
    "delete-candidates-unavailable": "unavailable",
    "delete-unavailable": "unavailable",
    "delete-targets-invalid": "invalid",
    // 未分组范围的授权失败（400）：目标不属于未分组集合，或其后代闭包触及工作区成员。
    "delete-targets-outside-ungrouped": "invalid",
    "bad-request": "invalid",
  });

  /**
   * 每个 kind 的兜底文案：只在错误本身没有 message 时使用。
   * 界面文案由消息表（票据 07）按 kind/code 选取，这里只保证「一定有一句能展示的话」。
   */
  const ERROR_MESSAGES = Object.freeze({
    "not-found": "工作区不存在或已移除",
    busy: "已有删除作业正在执行，请稍后再试",
    unavailable: "会话删除能力暂不可用，请重启 DSH 后再试",
    invalid: "请求无效，本次没有删除任何会话",
    transport: "请求失败，请检查连接后重试",
    unknown: "会话删除失败",
  });

  /** 非数组对象判定（纯数据归一的第一道闸门）。 */
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** 会话 ID 归一：只接受非空字符串（工作区/会话 ID 都是不透明字符串，不 trim、不猜大小写）。 */
  function readId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** 标题归一：空串与空白算「没有标题」，界面自行回退到侧栏已知标题。 */
  function readTitle(value) {
    if (typeof value !== "string") return null;
    const title = value.trim();
    return title.length > 0 ? title : null;
  }

  /**
   * 范围 key → 请求体字段（客户端 ↔ host 的契约，逐字遵守）：
   * - 工作区：`{ workspaceId }`（旧客户端兼容形态，保持可用）；
   * - 未分组：`{ scope: "ungrouped" }`——此时**不能**再带 workspaceId，两者同时出现是 400。
   *
   * @param {string} scopeKey - 工作区 ID 或 UNGROUPED_SCOPE。
   * @returns {object} 只含范围字段的请求体片段。
   */
  function scopeRequestFields(scopeKey) {
    return scopeKey === UNGROUPED_SCOPE ? { scope: UNGROUPED_SCOPE } : { workspaceId: scopeKey };
  }

  /**
   * 应答快照 → 范围 key，判定顺序固定（三态之外的输入一律 null，由调用方 fail-closed）：
   * 1. 本模块在 requestDeleteCandidates 打上的 `scopeKey` 标记（应答范围以请求为准）；
   * 2. 协议字段：`scope: "ungrouped"` → 未分组；否则 `workspaceId` → 该工作区；
   * 3. 都读不到 → null（形状非法：既没有未分组标记，也没有工作区 ID）。
   *
   * @param {object} snapshot - 候选查询应答或候选快照。
   * @returns {string|null} 范围 key 或 null。
   */
  function readSnapshotScopeKey(snapshot) {
    if (!isObject(snapshot)) return null;
    const stamped = readId(snapshot.scopeKey);
    if (stamped !== null) return stamped;
    if (snapshot.scope === UNGROUPED_SCOPE) return UNGROUPED_SCOPE;
    return readId(snapshot.workspaceId);
  }

  /** 阻塞者归一：kind 只做原样保留（客户端不枚举服务端原因，只在缺省时给 live）。 */
  function normalizeBlockedBy(raw) {
    if (!isObject(raw)) return null;
    return {
      kind: typeof raw.kind === "string" && raw.kind.length > 0 ? raw.kind : "live",
      sessionId: readId(raw.sessionId),
      title: readTitle(raw.title),
    };
  }

  /** 单个候选归一：只保留协议字段，未知字段丢弃（客户端不猜服务端）。 */
  function normalizeCandidate(raw) {
    if (!isObject(raw)) return null;
    const sessionId = readId(raw.sessionId);
    if (sessionId === null) return null;
    return {
      sessionId,
      title: readTitle(raw.title),
      actionable: raw.actionable === true,
      absent: raw.absent === true,
      blockedBy: normalizeBlockedBy(raw.blockedBy),
    };
  }

  /**
   * 候选快照 → 三个分组（可处理 / 被阻塞 / 仅残留）。
   *
   * 服务端已按闭包口径给出 `actionable`，客户端**只去重与分组**：重复会话按先出现者为准，
   * 非法条目直接丢弃（不伪造一个可删除目标）。absent 只在可处理目标里单列，被阻塞的会话
   * 即使日志已不在也不算「仅清理残留」（它要先过闸门，规格决策 24）。
   */
  function groupCandidates(snapshot) {
    const items = [];
    const seen = new Set();
    const raw = isObject(snapshot) && Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    for (const entry of raw) {
      const candidate = normalizeCandidate(entry);
      if (candidate === null || seen.has(candidate.sessionId)) continue;
      seen.add(candidate.sessionId);
      items.push(candidate);
    }
    const actionable = [];
    const blocked = [];
    const absent = [];
    for (const candidate of items) {
      if (candidate.actionable !== true) {
        blocked.push(candidate);
        continue;
      }
      actionable.push(candidate);
      if (candidate.absent === true) absent.push(candidate);
    }
    return { items, actionable, blocked, absent };
  }

  /** 按会话 ID 取候选（只用于状态层查询与「行是否仍存在」判定）。 */
  function findCandidate(list, sessionId) {
    if (!Array.isArray(list) || sessionId === null) return null;
    for (const candidate of list) {
      if (candidate.sessionId === sessionId) return candidate;
    }
    return null;
  }

  /** 空状态：未进入多选。每次退出都返回一份新对象，调用方不必担心共享引用。 */
  function initialSelectionState() {
    return {
      open: false,
      workspaceId: null,
      candidates: { items: [], actionable: [], blocked: [], absent: [] },
      selected: [],
      settling: false,
      result: null,
    };
  }

  /**
   * 进入多选模式（纯转移）：锁定候选快照里的工作区，必要时预选目标会话。
   *
   * 预选只在「该会话确实可处理」时发生（用户故事 18）：阻塞行没有勾选框，预选它等于制造一个
   * 提交时必然被跳过的选中项。范围读不出来（既无 workspaceId 也无未分组标记）时返回未进入
   * 状态（fail-closed）。
   *
   * 状态里的 `workspaceId` 是**范围 key**：工作区 ID，或未分组范围下的 UNGROUPED_SCOPE。
   * 沿用同一个字段是为了不把状态结构、弹窗字段与既有断言全部改名；翻译成请求体只在
   * scopeRequestFields 一处发生。
   *
   * @param {object} snapshot - 候选查询应答（`{ scope, workspaceId?, candidates, ... }`）。
   * @param {string} [preselectSessionId] - 进入多选时被点的那一行。
   * @returns {object} 新状态。
   */
  function enterSelection(snapshot, preselectSessionId) {
    const scopeKey = readSnapshotScopeKey(snapshot);
    if (scopeKey === null) return initialSelectionState();
    const candidates = groupCandidates(snapshot);
    const preselect = readId(preselectSessionId);
    const selected = preselect !== null && findCandidate(candidates.actionable, preselect) !== null
      ? [preselect]
      : [];
    return { open: true, workspaceId: scopeKey, candidates, selected, settling: false, result: null };
  }

  /** 退出多选：任何时刻都可用（含结算中、含结算后），退出即清空选中与结算条。 */
  function exitSelection() {
    return initialSelectionState();
  }

  /**
   * 切换某个会话的勾选（纯转移）。
   *
   * 只对可处理目标有效：阻塞行没有勾选框，整行点击也不该造出一个「看不到的选中项」。
   * 非多选态、结算中、未知会话 ID 都是无操作，且返回**同一个状态引用**（渲染层据此跳过重渲染）。
   */
  function toggleSelection(state, sessionId) {
    if (!isObject(state) || state.open !== true || state.settling === true) return state;
    const id = readId(sessionId);
    if (id === null || findCandidate(state.candidates?.actionable, id) === null) return state;
    const selected = state.selected.includes(id)
      ? state.selected.filter((entry) => entry !== id)
      : [...state.selected, id];
    return { ...state, selected };
  }

  /**
   * 全选（纯转移）：范围 = 候选里全部 `actionable` 目标（含 absent）。
   *
   * **不看任何视图过滤**（规格决策 26 / 测试 C6）：搜索、归档过滤、折叠隐藏、归档行都只影响
   * 可见行，不改变全选范围。被阻塞的目标无论从哪个入口都不会被选中。
   */
  function selectAllActionable(state) {
    if (!isObject(state) || state.open !== true || state.settling === true) return state;
    return { ...state, selected: (state.candidates?.actionable ?? []).map((candidate) => candidate.sessionId) };
  }

  /**
   * 全选按钮的点击语义（纯转移）：未全选 → 全选全部可处理目标；已全选 → 清空选中。
   *
   * 为什么不把开关语义直接塞进 `selectAllActionable`（用户 2026-10-27 的交互要求）：按钮在
   * 已全选时若继续全选，点击前后界面完全一样，用户会以为按钮失灵或没点中。改成一键反向
   * 之后，同一个按钮才有「开关」应有的可预期反馈：第一次点击全选、第二次清空、第三次重新
   * 全选。而 `selectAllActionable` 保留「只做全选」的单一语义，仍是这个开关的一半实现。
   *
   * 判定复用 `selectionCounts().allSelected`（唯一判据，见其注释）：部分选中算「未全选」，
   * 此时点击仍然是全选而不是清空——否则「已选 2 个」时点一下反而全没了，是明显的误伤。
   * 无操作条件与 `selectAllActionable` 完全一致：未进入多选、结算中都返回**同一引用**
   * （渲染层据此跳过重渲染）；可处理目标为 0 时全选结果本来就是空集合。
   */
  function toggleSelectAllActionable(state) {
    if (!isObject(state) || state.open !== true || state.settling === true) return state;
    if (selectionCounts(state).allSelected === true) return { ...state, selected: [] };
    return selectAllActionable(state);
  }

  /** 进入/退出「结算中」：渲染层发起请求前调用，用于禁用按钮与确认框（状态字段的唯一写入口）。 */
  function markSettling(state, settling) {
    if (!isObject(state) || state.open !== true) return state;
    const next = settling === true;
    return state.settling === next ? state : { ...state, settling: next };
  }

  /**
   * 结算后（或重试前）用新快照替换候选集合（纯转移）。
   *
   * 位移规则（规格决策 20）：
   * - 选中集合与新候选的可处理集合取交集：结算后不再可处理的目标自动消失，**新变成可处理的
   *   目标只重新获得勾选框，不会自动回到选中**；
   * - 结算条（`result`）保留：它描述的是「最近一次真的发生了什么」；
   * - 范围不符时拒绝替换：快照缺范围、来自别的工作区，或未分组快照混进工作区状态（反之
   *   亦然）都拒绝——多选范围在进入时就锁定了（决策 17），范围外的候选不能混进来。
   */
  function refreshSelectionCandidates(state, snapshot) {
    if (!isObject(state) || state.open !== true) return state;
    if (readSnapshotScopeKey(snapshot) !== state.workspaceId) return state;
    const candidates = groupCandidates(snapshot);
    const selected = state.selected.filter((sessionId) => findCandidate(candidates.actionable, sessionId) !== null);
    return { ...state, candidates, selected };
  }

  /**
   * 本次会提交的目标（按候选顺序，即服务端闭包顺序）：选中集合 ∩ 可处理目标。
   *
   * 返回**候选对象**而不仅是 ID：确认框要用它显示前 5 个标题与 absent 计数（用户故事 27），
   * 提交时再投影成 ID 列表——两者永远来自同一份集合，不会出现「说 3 个、提交 2 个」。
   */
  function selectionTargets(state) {
    if (!isObject(state) || state.open !== true) return [];
    const targets = [];
    for (const candidate of state.candidates?.actionable ?? []) {
      if (state.selected.includes(candidate.sessionId)) targets.push(candidate);
    }
    return targets;
  }

  /**
   * 计数口径（规格决策 18/24）：已选 / 将处理 / 被阻塞 / absent / 总数 / 删除按钮可用性 /
   * 是否已全选。
   *
   * `selected` 与 `targets` 在不变式（选中集合 ⊆ 可处理集合）下恒等；分开报出是因为
   * 「用户勾了几个」与「这次真的会提交几个」是两个独立的用户可见事实，任何一步过滤都不许
   * 让它们悄悄分叉。
   *
   * `allSelected` 是「全选按钮当前是否已全选」的**唯一判据**（按钮文案、图标与再次点击的
   * 语义都从这里读）。因为 targets ⊆ actionable 且 targets 逐项去重，**覆盖全部**等价于
   * 两者数量相等且 actionable 非空；不能写成 `selected >= actionable`：那会把「选中集合里
   * 混进范围外 ID」也算成已全选，从而让下一次点击变成清空而不是全选。
   */
  function selectionCounts(state) {
    const targets = selectionTargets(state);
    const candidates = isObject(state) ? state.candidates : null;
    const blocked = Array.isArray(candidates?.blocked) ? candidates.blocked.length : 0;
    const actionable = Array.isArray(candidates?.actionable) ? candidates.actionable.length : 0;
    const absent = Array.isArray(candidates?.absent) ? candidates.absent.length : 0;
    return {
      selected: Array.isArray(state?.selected) ? state.selected.length : 0,
      targets: targets.length,
      actionable,
      blocked,
      absent,
      total: Array.isArray(candidates?.items) ? candidates.items.length : actionable + blocked,
      deletable: targets.length > 0 && isObject(state) && state.settling !== true,
      allSelected: actionable > 0 && targets.length === actionable,
    };
  }

  /** 是否处于多选模式。 */
  function isSelectionOpen(state) {
    return isObject(state) && state.open === true;
  }

  /** 某个会话当前是否被勾选（纯查询，供行首勾选框使用）。 */
  function isSessionSelected(state, sessionId) {
    const id = readId(sessionId);
    return id !== null && isObject(state) && Array.isArray(state.selected) && state.selected.includes(id);
  }

  /** 某个会话当前是否可处理（纯查询：只有可处理行才渲染勾选框）。 */
  function isSessionActionable(state, sessionId) {
    return findCandidate(isObject(state) ? state.candidates?.actionable : null, readId(sessionId)) !== null;
  }

  /** 取某个会话的候选（含阻塞原因/是否仅残留），没有则 null。 */
  function selectionCandidateOf(state, sessionId) {
    return findCandidate(isObject(state) ? state.candidates?.items : null, readId(sessionId));
  }

  /**
   * Escape 的优先级（规格决策 30 的状态机侧）：确认框打开时只关确认框，否则退出多选。
   *
   * 渲染层按返回值分派即可；把这条优先级放在纯函数里，是为了让「Esc 先关确认框」与
   * 「Esc 始终能退出」两件事只有一个判定点，不会在两处各写一遍而分叉。
   *
   * @returns {"close-confirm"|"exit-selection"|"none"} 稳定动作名。
   */
  function escapeAction(state, input) {
    if (isObject(input) && input.confirmOpen === true) return "close-confirm";
    return isSelectionOpen(state) ? "exit-selection" : "none";
  }

  /** 五态全零计数（键集合与 RESULT_STATES 同源）。 */
  function zeroCounts() {
    const counts = {};
    for (const state of RESULT_STATES) counts[state] = 0;
    return counts;
  }

  /** 结果态归一：别名先折平，未知状态返回 null（不把「读不懂」算进任何一个态）。 */
  function normalizeResultState(value) {
    const alias = typeof value === "string" ? RESULT_STATE_ALIASES[value] : undefined;
    const state = alias === undefined ? value : alias;
    return typeof state === "string" && RESULT_STATES.includes(state) ? state : null;
  }

  /**
   * 单个作业回执归一（幂等：合并后的回执再归一一次，结果与批次计数不变）。
   *
   * 计数一律**从逐目标 results 重算**，不信任服务端的聚合值：这样别名态、未知态与「服务端
   * 少给了一条结果」都会体现在守恒结论里（`conserved` 为假），而不是被悄悄算进某个状态。
   */
  function normalizeSettlement(summary) {
    const source = isObject(summary) ? summary : {};
    const counts = zeroCounts();
    const results = [];
    const unknown = [];
    for (const entry of Array.isArray(source.results) ? source.results : []) {
      const raw = isObject(entry) ? entry : {};
      const state = normalizeResultState(raw.state);
      if (state === null) unknown.push(readId(raw.sessionId) ?? "<unknown>");
      else counts[state] += 1;
      results.push(state === null ? raw : { ...raw, state });
    }
    const total = RESULT_STATES.reduce((sum, state) => sum + counts[state], 0);
    const targetCount = Number.isSafeInteger(source.targetCount) && source.targetCount >= 0
      ? source.targetCount
      : total;
    const note = isObject(source.note) ? source.note : {};
    const batches = Number.isSafeInteger(source.batches) && source.batches > 0 ? source.batches : 1;
    return {
      counts,
      total,
      targetCount,
      conserved: total === targetCount && unknown.length === 0,
      results,
      unknown,
      blocked: Array.isArray(source.blocked) ? source.blocked : [],
      collateral: Array.isArray(source.collateral) ? source.collateral : [],
      diagnostics: Array.isArray(source.diagnostics) ? source.diagnostics : [],
      note: {
        newDescendants: Number.isSafeInteger(note.newDescendants) ? note.newDescendants : 0,
        ...(note.degraded === true ? { degraded: true } : {}),
      },
      batches,
    };
  }

  /**
   * 合并多批回执（客户端分批提交的结果聚合）。
   *
   * 跨批守恒以「合计」为准：任何一批不自洽，整轮都不自洽；`batches` 记录真的提交了几批，
   * 让界面上「删了 N 个」背后有可复核的批次账。
   */
  function mergeDeleteSettlements(settlements) {
    const counts = zeroCounts();
    const merged = {
      counts,
      total: 0,
      targetCount: 0,
      conserved: true,
      results: [],
      unknown: [],
      blocked: [],
      collateral: [],
      diagnostics: [],
      note: { newDescendants: 0 },
      batches: 0,
    };
    for (const entry of Array.isArray(settlements) ? settlements : []) {
      const batch = normalizeSettlement(entry);
      for (const state of RESULT_STATES) counts[state] += batch.counts[state];
      merged.total += batch.total;
      merged.targetCount += batch.targetCount;
      merged.conserved = merged.conserved && batch.conserved;
      merged.batches += batch.batches;
      merged.results.push(...batch.results);
      merged.unknown.push(...batch.unknown);
      merged.blocked.push(...batch.blocked);
      merged.collateral.push(...batch.collateral);
      merged.diagnostics.push(...batch.diagnostics);
      merged.note.newDescendants += batch.note.newDescendants;
      if (batch.note.degraded === true) merged.note.degraded = true;
    }
    merged.conserved = merged.conserved && merged.total === merged.targetCount && merged.unknown.length === 0;
    return merged;
  }

  /**
   * 结算后重置（纯转移，规格决策 20 / 测试 D6）。
   *
   * - 选中集合只保留「结果仍是 failed 且候选里仍可处理」的目标：skipped / raced 移出选中，
   *   deleted / absent 的行直接消失；
   * - 全部提交目标都是 deleted/absent 时自动退出多选（返回未进入状态）；
   * - 结算中标记只在**真的拿到回执**时清除；刷新候选由调用方紧接着做（本函数不拉数据）。
   *
   * 「全部」的判据必须同时成立：回执覆盖了本次提交的全部目标（`total === 提交数`）且这些
   * 结果全是 deleted/absent。分批中途失败时 total 小于提交数，此时**绝不自动退出**——否则
   * 用户剩下的选中会连同模式一起消失。
   */
  function applySettlement(state, settlement) {
    if (!isObject(state) || state.open !== true) return state;
    // 非对象回执（端口返回 undefined / 被上层包装丢掉）不改变任何状态：不能把「没拿到回执」
    // 当成「选中全部失效」。
    if (!isObject(settlement)) return state;
    const merged = mergeDeleteSettlements([settlement]);
    const submitted = selectionTargets(state).length;
    const retained = [];
    for (const result of merged.results) {
      if (normalizeResultState(result?.state) !== "failed") continue;
      const sessionId = readId(result?.sessionId);
      if (sessionId === null || retained.includes(sessionId)) continue;
      if (findCandidate(state.candidates?.actionable, sessionId) === null) continue;
      retained.push(sessionId);
    }
    const settledEveryTarget = merged.total > 0
      && merged.total === submitted
      && merged.counts.deleted + merged.counts.absent === merged.total;
    if (settledEveryTarget) return initialSelectionState();
    return { ...state, selected: retained, settling: false, result: merged };
  }

  /** 按上限切分目标（顺序不变、不丢项、不合并）。非法上限回退到服务端上限 200。 */
  function chunkDeleteTargets(targets, limit) {
    const size = Number.isSafeInteger(limit) && limit > 0 ? limit : TARGETS_LIMIT;
    const list = Array.isArray(targets) ? targets.filter((entry) => readId(entry) !== null) : [];
    const chunks = [];
    for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
    return chunks;
  }

  /** 构造一条归一后的失败原因（kind 决定界面文案与入口可用性，code 保留原始稳定码）。 */
  function deleteFailure(kind, code, message) {
    return { code: code ?? null, kind, message: message ?? ERROR_MESSAGES[kind] ?? ERROR_MESSAGES.unknown };
  }

  /** 空选中/空目标的统一失败（不是服务端拒绝，因此不带 code）。 */
  function emptyTargetsFailure() {
    return deleteFailure("invalid", null, "没有可处理的目标");
  }

  /**
   * 错误归一：任何抛出值 → `{ code, kind, message }`。
   *
   * kind 的用途是让界面只按「原因类」分支：not-found（工作区没了，入口应关闭）、busy（409，
   * 可重试）、unavailable（503，入口不可用）、invalid（400，请求本身有问题）、transport
   * （没有稳定码：连接/协议层失败）、unknown（有码但不认识）。message 原样透传，不吞细节，
   * 也不把异常里的路径/堆栈拼进文案。
   */
  function normalizeDeleteFailure(error) {
    const code = isObject(error) && typeof error.code === "string" && error.code.length > 0 ? error.code : null;
    // 服务端给出的 message 已经是可展示文案（不含路径/堆栈），优先原样保留；没有时才用兜底文案。
    const message = isObject(error) && typeof error.message === "string" && error.message.length > 0
      ? error.message
      : undefined;
    if (code === null) return deleteFailure("transport", null, message);
    if (Object.prototype.hasOwnProperty.call(ERROR_KINDS, code)) return deleteFailure(ERROR_KINDS[code], code, message);
    return deleteFailure("unknown", code, message);
  }

  /**
   * 读 RPC 端口：唯一约定是 `{ call(request) }`；直接传函数也接受（票据 06/07 的注入片）。
   * 两者都没有时返回 null，由调用方按「传输层失败」fail-closed，绝不静默不发请求。
   */
  function readPort(port) {
    if (isObject(port) && typeof port.call === "function") return port;
    if (typeof port === "function") return { call: port };
    return null;
  }

  /** 发一次 RPC 并把失败归一；返回值形状固定为 `{ok:true, value}` / `{ok:false, error}`。 */
  async function callAction(port, request) {
    const rpc = readPort(port);
    if (rpc === null) return { ok: false, error: deleteFailure("transport", null, "当前 DSH 未提供插件 RPC") };
    try {
      return { ok: true, value: await rpc.call(request) };
    } catch (error) {
      return { ok: false, error: normalizeDeleteFailure(error) };
    }
  }

  /**
   * 候选查询。
   *
   * 形状校验是**协议层**职责：应答里没有 candidates 数组时按失败处理——把「读不懂」当成
   * 「一个候选都没有」会让多选模式在空列表里打开，用户以为工作区已经清空。
   */
  async function requestDeleteCandidates(port, workspaceId) {
    const scopeKey = readId(workspaceId);
    if (scopeKey === null) return { ok: false, error: deleteFailure("invalid", "bad-request") };
    const scopeFields = scopeRequestFields(scopeKey);
    const outcome = await callAction(port, { action: ACTION_CANDIDATES, ...scopeFields });
    if (outcome.ok !== true) return outcome;
    const snapshot = outcome.value;
    if (!isObject(snapshot) || !Array.isArray(snapshot.candidates)) {
      return { ok: false, error: deleteFailure("unknown", null) };
    }
    // 范围以请求为准：应答缺字段或给了别的范围都不改变「本次锁定的是谁」。scopeKey 是本模块
    // 打上的内部标记（不进请求体），enterSelection / refreshSelectionCandidates 只认它。
    return { ok: true, snapshot: { ...snapshot, ...scopeFields, scopeKey } };
  }

  /** 候选标题映射（只用于让回执/阻塞原因能指名是谁；没有标题就不传）。 */
  function titlesOfCandidates(targets) {
    // 无原型对象：会话 ID 是不透明字符串，绝不会因为它恰好叫 __proto__ 就把标题写进原型链。
    const titles = Object.create(null);
    let count = 0;
    for (const candidate of targets) {
      if (candidate.title === null) continue;
      titles[candidate.sessionId] = candidate.title;
      count += 1;
    }
    return count > 0 ? titles : null;
  }

  /**
   * 单批删除（调用方保证 targets 不超过服务端上限）。
   *
   * `options.workspaceId` 是**范围 key**（工作区 ID 或 UNGROUPED_SCOPE）：请求体里按契约翻译成
   * `{ workspaceId }` 或 `{ scope: "ungrouped" }`，两者绝不同时出现。
   */
  async function requestDeleteBatch(port, options) {
    const scopeKey = readId(isObject(options) ? options.workspaceId : null);
    const targets = Array.isArray(options?.targets)
      ? options.targets.filter((entry) => readId(entry) !== null)
      : [];
    if (scopeKey === null || targets.length === 0) {
      return { ok: false, error: deleteFailure("invalid", "delete-targets-invalid") };
    }
    const request = { action: ACTION_REMOVE, ...scopeRequestFields(scopeKey), targets };
    if (isObject(options?.titles)) request.titles = options.titles;
    const outcome = await callAction(port, request);
    if (outcome.ok !== true) return outcome;
    const summary = outcome.value;
    if (!isObject(summary) || !Array.isArray(summary.results)) {
      // 读不懂的回执绝不当成「删掉了 0 个」：那是把一次真实删除显示成什么都没发生。
      return { ok: false, error: deleteFailure("unknown", null) };
    }
    return { ok: true, settlement: normalizeSettlement(summary) };
  }

  /**
   * 一个**轮次**的删除：自动分批、顺序提交、合并结果。
   *
   * 失败即停（不提交后续批次）：同一时刻只允许一个作业，继续提交只会得到 409，而用户看到的
   * 会更难解释。已完成的批次仍并入 `settlement`（`null` 表示一个批次都没成功）。
   */
  async function requestDeleteAll(port, options) {
    // options.workspaceId 是范围 key（工作区 ID 或 UNGROUPED_SCOPE），见 requestDeleteBatch。
    const scopeKey = readId(isObject(options) ? options.workspaceId : null);
    const targets = Array.isArray(options?.targets)
      ? options.targets.filter((entry) => readId(entry) !== null)
      : [];
    if (scopeKey === null || targets.length === 0) {
      return { ok: false, error: deleteFailure("invalid", "delete-targets-invalid"), settlement: null, batches: 0, total: targets.length };
    }
    const chunks = chunkDeleteTargets(targets, options?.limit);
    const settlements = [];
    for (const chunk of chunks) {
      const outcome = await requestDeleteBatch(port, { workspaceId: scopeKey, targets: chunk, titles: options?.titles });
      if (outcome.ok !== true) {
        return {
          ok: false,
          error: outcome.error,
          settlement: settlements.length === 0 ? null : mergeDeleteSettlements(settlements),
          batches: settlements.length,
          total: targets.length,
        };
      }
      settlements.push(outcome.settlement);
    }
    return {
      ok: true,
      error: null,
      settlement: mergeDeleteSettlements(settlements),
      batches: settlements.length,
      total: targets.length,
    };
  }

  /**
   * 跑一轮作业：读端口 → 结算纯转移 → （若仍开着）重拉候选。
   *
   * 返回 `{ ok, state, settlement, error, refreshError }`：
   * - 提交失败时 state 已经消化了「真的发生了什么」（部分批次 + 结算中复位），调用方只需展示；
   * - `refreshError` 与 `error` 分开：刷新候选失败不影响本轮结果，界面只降级勾选框。
   */
  async function runSelectionRound(port, state, options) {
    const targets = selectionTargets(state);
    if (targets.length === 0) return { ok: false, state, settlement: null, error: emptyTargetsFailure() };
    const outcome = await requestDeleteAll(port, {
      workspaceId: state.workspaceId,
      targets: targets.map((candidate) => candidate.sessionId),
      titles: titlesOfCandidates(targets),
      limit: options?.limit,
    });
    const settlement = outcome.settlement;
    let next = settlement === null ? markSettling(state, false) : applySettlement(state, settlement);
    if (outcome.ok !== true) return { ok: false, state: next, settlement, error: outcome.error };
    if (isSelectionOpen(next) !== true) return { ok: true, state: next, settlement, error: null, refreshError: null };
    const refreshed = await requestDeleteCandidates(port, next.workspaceId);
    if (refreshed.ok === true) next = refreshSelectionCandidates(next, refreshed.snapshot);
    return { ok: true, state: next, settlement, error: null, refreshError: refreshed.ok === true ? null : refreshed.error };
  }

  /**
   * 进入多选（异步编排）：先查候选。
   *
   * 候选查询失败/超时 → 不进入模式（决策 25）：多选里每一行是否可处理都依赖这份快照，
   * 拿不到就不该让用户点进一个「什么都不能选」的模式。
   *
   * @param {string} scopeKey - 范围 key（工作区 ID 或 UNGROUPED_SCOPE）。
   */
  async function openSelection(port, scopeKey, preselectSessionId) {
    const loaded = await requestDeleteCandidates(port, scopeKey);
    if (loaded.ok !== true) return { ok: false, state: initialSelectionState(), error: loaded.error };
    return { ok: true, state: enterSelection(loaded.snapshot, preselectSessionId), error: null };
  }

  /** 提交当前选中（异步编排）：操作条上的「删除」。 */
  async function submitSelection(port, state, options) {
    if (!isSelectionOpen(state)) return { ok: false, state, settlement: null, error: emptyTargetsFailure() };
    return await runSelectionRound(port, state, options);
  }

  /**
   * 重试（异步编排，决策 20 / 用户故事 31）：**新一轮作业**。
   *
   * 先重拉候选、重算计数（新变成可处理的目标重新获得勾选框但不自动回到选中），再按重算后的
   * 选中提交。候选刷新失败时保持原状并回报原因——重试不能拿一份过期快照去删除。
   */
  async function retrySelection(port, state, options) {
    if (!isSelectionOpen(state)) return { ok: false, state, settlement: null, error: emptyTargetsFailure() };
    const refreshed = await requestDeleteCandidates(port, state.workspaceId);
    if (refreshed.ok !== true) return { ok: false, state, settlement: null, error: refreshed.error };
    const next = refreshSelectionCandidates(state, refreshed.snapshot);
    if (selectionTargets(next).length === 0) {
      return { ok: false, state: markSettling(next, false), settlement: null, error: emptyTargetsFailure() };
    }
    return await runSelectionRound(port, next, options);
  }

  // 只暴露渲染层与测试实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    SESSION_DELETE_TARGETS_LIMIT: TARGETS_LIMIT,
    ACTION_CANDIDATES,
    ACTION_REMOVE,
    UNGROUPED_SCOPE,
    ERROR_KINDS,
    RESULT_STATES,
    applySettlement,
    chunkDeleteTargets,
    enterSelection,
    escapeAction,
    exitSelection,
    initialSelectionState,
    isSelectionOpen,
    isSessionActionable,
    isSessionSelected,
    markSettling,
    mergeDeleteSettlements,
    normalizeDeleteFailure,
    openSelection,
    refreshSelectionCandidates,
    requestDeleteAll,
    requestDeleteBatch,
    requestDeleteCandidates,
    retrySelection,
    selectAllActionable,
    selectionCandidateOf,
    selectionCounts,
    selectionTargets,
    submitSelection,
    toggleSelectAllActionable,
    toggleSelection,
  });
})(globalThis);
