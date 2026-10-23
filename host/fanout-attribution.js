/**
 * fan-out 归属判定与身份注册表服务（R2 票据 10：fanout-host 拆为三服务 + coordinator）。
 *
 * ## 职责
 * 1. **身份解析**：marker（agent options）与持久化记录两条来源的 fan-out 身份；
 *    `isFanoutAgent` / `isFanoutIdentity` / `fanoutAttemptKey` 是公开纯函数。
 * 2. **注册表**：attempt key -> record、childId -> record、sessionId -> record 三张路由表，
 *    以及 childId -> session 有界 LRU、最近见过的 id 集合、fan-out session 弱引用集合、
 *    已 interrupt 的 attempt key 集合。这些 Map/Set 的**唯一 owner 就是本文件**。
 * 3. **归属判定**：首轮宽松 fallback（`turnMatchesRecordMessage`）、续作严格证明
 *    （`continuationAttribution`）、续作执行前置条件（`continuationReadiness`）。
 * 4. **归属老化**（票据 07）：观察窗口、到期后调用 manager 精确 API 标记 needs_attention，
 *    以及只读诊断计数。
 * 5. **身份预检**（`precheckChildIdentity`）：index.js 在产生任何副作用之前调用。
 *
 * ## 边界
 * - 本模块**不发布事件**：归属违规通过 `managerPort.recordAttributionViolation` 交给
 *   manager（manager 自己 emit），Host 侧广播（onEvent）仍只在 coordinator 发生。
 * - 本模块**不做结算**：record 的 finish / close / admission 暂存回放都在 lifecycle 服务里，
 *   因此依赖方向是单向的 lifecycle -> attribution，不存在 ESM 环。
 */
import {
  FANOUT_EVENT_LOG_LIMIT,
  cloneJson,
  isObject,
  sessionEventLog,
  turnOf,
} from "./fanout-event-log.js";
import { messageIdsOfTurn } from "../shared/turn-settlement.js";

export const FANOUT_MARKER = "__degFanout";
export const FANOUT_PARENT_TASK_MARKER = "__degFanoutParentTaskId";
export const FANOUT_PARENT_AGENT_MARKER = "__degFanoutParentAgentId";
export const FANOUT_SHARD_MARKER = "__degFanoutShardId";
export const FANOUT_ATTEMPT_MARKER = "__degFanoutAttempt";

/**
 * fan-out 身份的四个可比较字段：预检要求 marker 与持久化身份在这些字段上逐字一致
 * （不做字段级合并，否则冲突会被静默取一方，等于放行伪造 marker）。
 */
const FANOUT_IDENTITY_FIELDS = Object.freeze(["parentTaskId", "parentAgentId", "shardId", "attempt"]);

/** 归属老化的默认宽限（毫秒）；0 表示显式禁用（测试/极端配置）。 */
const ATTRIBUTION_AGING_DEFAULT_MS = 60000;

function textOf(value) {
  return typeof value === "string" ? value : "";
}

export function nonEmptyText(value) {
  const text = textOf(value);
  return text.trim().length > 0 ? text : "";
}

function attemptValue(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function markerAttempt(options) {
  return attemptValue(options?.[FANOUT_ATTEMPT_MARKER]);
}

function markerOptions(agent) {
  if (isObject(agent?.options)) return agent.options;
  if (isObject(agent?.agentOptions)) return agent.agentOptions;
  return {};
}

function markerText(options, key) {
  const value = options?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function fanoutAttemptKey(parentTaskId, shardId, attempt) {
  return [String(parentTaskId), String(shardId), String(attempt)].join("\u001f");
}

function markerFanoutIdentity(options) {
  if (options?.[FANOUT_MARKER] !== true) return undefined;
  const parentTaskId = markerText(options, FANOUT_PARENT_TASK_MARKER);
  const parentAgentId = markerText(options, FANOUT_PARENT_AGENT_MARKER);
  const shardId = markerText(options, FANOUT_SHARD_MARKER);
  const attempt = markerAttempt(options);
  if (parentTaskId === undefined || parentAgentId === undefined || shardId === undefined || attempt === undefined) return undefined;
  return { parentTaskId, parentAgentId, shardId, attempt };
}

/**
 * 只信任显式标记且字段完整的持久化记录；普通 child 的 role/parentId 不足以证明
 * 它来自 fan-out，避免 cold-resume 把普通专家误路由到 fan-out 状态机。
 */
function persistedFanoutIdentity(record) {
  if (!isObject(record) || record.fanout !== true) return undefined;
  const parentTaskId = nonEmptyText(record.fanoutParentTaskId ?? record.parentTaskId);
  const parentAgentId = nonEmptyText(record.fanoutParentAgentId ?? record.parentId);
  const shardId = nonEmptyText(record.fanoutShardId ?? record.shardId);
  const attempt = attemptValue(record.fanoutAttempt ?? record.attempt);
  if (parentTaskId === "" || parentAgentId === "" || shardId === "" || attempt === undefined) return undefined;
  return { parentTaskId, parentAgentId, shardId, attempt };
}

export function isFanoutIdentity(record) {
  return persistedFanoutIdentity(record) !== undefined;
}

function fanoutIdentityOf(agent, persistedIdentity) {
  return markerFanoutIdentity(markerOptions(agent)) ?? persistedFanoutIdentity(persistedIdentity);
}

/** 判断 agent 是否携带完整 fan-out marker 或可信 cold-resume 身份。 */
export function isFanoutAgent(agent, persistedIdentity) {
  return fanoutIdentityOf(agent, persistedIdentity) !== undefined;
}

export function childIdOf(value) {
  if (!isObject(value)) return undefined;
  const childId = typeof value.childId === "string" ? value.childId : value.subagentId;
  return typeof childId === "string" && childId.length > 0 ? childId : undefined;
}

export function sessionIdOf(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  const agentId = agent?.id;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

/**
 * 归属服务的状态容器：全部 Map/Set、计数器与时钟/端口引用都在这里一次性创建。
 *
 * 为什么要拆成「state + 单元工厂」：单个 `createFanoutAttribution` 闭包会同时承载
 * 注册表、归属判定、老化与诊断四块逻辑，实测超过工厂 ≤400 行的阈值。拆开后每个单元
 * 工厂只接收同一个 `state`（对象引用），**所有权的文件归属不变**：这些 Map/Set 仍然
 * 只在本文件被创建、也只在本文件被读写。
 */
function createAttributionState(deps) {
  const {
    log = () => {},
    managerPort = {},
    clock = {},
    attributionAgingMs = ATTRIBUTION_AGING_DEFAULT_MS,
    resolveChildSession,
    parentAgentOf,
    hasContinueRoute = () => false,
  } = deps;
  return {
    // ── 协作方（只读引用） ──────────────────────────────────────────────────
    log,
    managerPort,
    resolveChildSession,
    parentAgentOf,
    hasContinueRoute,
    attributionAgingMs,
    // 与拆分前一致：从注入时钟里**取出函数值**再以裸函数调用（不改变 this 绑定语义）。
    agingNow: typeof clock?.now === "function" ? clock.now : () => Date.now(),
    agingSetTimeout: typeof clock?.setTimeout === "function" ? clock.setTimeout : (fn, ms) => setTimeout(fn, ms),
    agingClearTimeout: typeof clock?.clearTimeout === "function" ? clock.clearTimeout : (handle) => clearTimeout(handle),
    // ── 身份注册表（本文件唯一 owner） ──────────────────────────────────────
    /** attempt key -> record（活动 attempt）。 */
    records: new Map(),
    /** childId -> record（活动 attempt 的 child 路由）。 */
    childRecords: new Map(),
    /** sessionId -> record（活动 attempt 的 session 路由）。 */
    sessionRecords: new Map(),
    /** childId -> session 有界 LRU（多轮复用解析既有 child 用）。 */
    childSessions: new Map(),
    /** 终态后仍保留最近见过的 fan-out session/child id（有界）。 */
    knownIds: new Set(),
    knownIdOrder: [],
    /** fan-out session 实例的弱引用集合（id 索引被 LRU 驱逐后的兜底识别）。 */
    fanoutSessions: new WeakSet(),
    /** 已 interrupt 过的 attempt key（有界，保证同一 attempt 最多 interrupt 一次）。 */
    interruptedKeys: new Set(),
    interruptedKeyOrder: [],
    // ── admission 闸门与老化计数 ────────────────────────────────────────────
    /** admission 闸门：close 之后不再接受任何新的 admission。 */
    closed: false,
    /** 仍挂着老化定时器的 record 数（tombstone 不计入这里）。 */
    attributionAgingPending: 0,
    /** 真正把 attempt 标记为 aged 的次数（manager changed=true）。 */
    attributionAgingAgedCount: 0,
    /** 到期时已终态/身份不可读而被跳过的次数（只读诊断）。 */
    attributionAgingSkippedCount: 0,
    /** 最近一次成功老化（只读诊断；只含身份与结果，不含 prompt/结果负载）。 */
    lastAttributionAged: null,
  };
}

/**
 * 注册表单元：身份 -> record 的路由表、有界 id/child 索引、interrupt 判重与 admission 闸门。
 *
 * 这些 Map/Set 的**唯一写面**就在本函数返回的命令里；lifecycle / coordinator 只能调用命令，
 * 拿不到 Map 本身（不暴露可写引用）。
 */
function createAttributionRegistry(state) {
  const {
    records,
    childRecords,
    sessionRecords,
    childSessions,
    knownIds,
    knownIdOrder,
    fanoutSessions,
    interruptedKeys,
    interruptedKeyOrder,
    log,
  } = state;
  const CHILD_SESSION_LIMIT = FANOUT_EVENT_LOG_LIMIT;
  const KNOWN_ID_LIMIT = FANOUT_EVENT_LOG_LIMIT * 4;

  function rememberInterrupted(key) {
    if (interruptedKeys.has(key)) return;
    interruptedKeys.add(key);
    interruptedKeyOrder.push(key);
    while (interruptedKeyOrder.length > KNOWN_ID_LIMIT) interruptedKeys.delete(interruptedKeyOrder.shift());
  }

  /** 从 launcher/canceller 的 input 还原 attempt key；字段不完整时返回 undefined。 */
  function interruptKeyFor(input) {
    const parentTaskId = nonEmptyText(input?.parentTaskId);
    const shardId = nonEmptyText(input?.shardId);
    const attempt = attemptValue(input?.attempt);
    return parentTaskId === "" || shardId === "" || attempt === undefined
      ? undefined
      : fanoutAttemptKey(parentTaskId, shardId, attempt);
  }

  function rememberKnownId(value) {
    if (typeof value !== "string" || value.length === 0 || knownIds.has(value)) return;
    knownIds.add(value);
    knownIdOrder.push(value);
    while (knownIdOrder.length > KNOWN_ID_LIMIT) knownIds.delete(knownIdOrder.shift());
  }

  /** 登记 childId -> session（有界 LRU），供多轮复用解析既有 child。 */
  function rememberChildSession(childId, session) {
    if (typeof childId !== "string" || childId.length === 0 || !isObject(session)) return;
    if (childSessions.has(childId)) childSessions.delete(childId);
    childSessions.set(childId, session);
    while (childSessions.size > CHILD_SESSION_LIMIT) {
      const oldest = childSessions.keys().next();
      if (oldest.done === true) break;
      childSessions.delete(oldest.value);
    }
  }

  /** 弱引用登记 fan-out session 实例（id 索引被 LRU 驱逐后仍能识别迟到事件）。 */
  function rememberSession(session) {
    if (isObject(session)) fanoutSessions.add(session);
  }

  /**
   * 解析既有 child 的 session：优先宿主注入的解析器（覆盖 cold-resume 换实例的形态），
   * 其次 runtime 自己的有界索引。都拿不到时返回 undefined——续作路径不因此失败，
   * 而是先按 childId 绑定会话路由，由 sendMessage 决定该 child 是否真的可继续。
   */
  function continuationSession(childId) {
    if (typeof state.resolveChildSession === "function") {
      let resolved;
      try {
        resolved = state.resolveChildSession(childId);
      } catch (error) {
        log("fan-out resolveChildSession failed", error);
        resolved = undefined;
      }
      if (isObject(resolved)) return resolved;
    }
    const indexed = childSessions.get(childId);
    return isObject(indexed) ? indexed : undefined;
  }

  function registerRoute(record, childId, sessionId) {
    if (childId !== undefined) {
      record.childId = childId;
      childRecords.set(childId, record);
    }
    if (sessionId !== undefined) {
      record.sessionId = sessionId;
      sessionRecords.set(sessionId, record);
    }
  }

  function forgetRecord(record) {
    if (records.get(record.key) === record) records.delete(record.key);
    if (record.childId !== undefined && childRecords.get(record.childId) === record) childRecords.delete(record.childId);
    // session replacement 会让同一个 record 关联过多个 session id（实例换了、id 可能同也可能
    // 不同）：终态时必须把**全部**历史 id 都摘掉，否则旧 id 的迟到事件还能找回一个已结算的
    // record（既留下悬挂引用，又会在严格判定里产生无意义诊断）。
    if (record.sessionIds instanceof Set) {
      for (const sessionId of record.sessionIds) {
        if (sessionRecords.get(sessionId) === record) sessionRecords.delete(sessionId);
      }
      record.sessionIds.clear();
    }
    if (record.sessionId !== undefined && sessionRecords.get(record.sessionId) === record) sessionRecords.delete(record.sessionId);
  }

  /**
   * 安装/更新 record 的会话实例（**latest-session 规则**）。
   *
   * 只有两个可信来源会推进 `record.sessionGeneration`：
   * - activation 边界 `handleAgentCreated()`：cold-resume/replacement 带来的新 session 实例；
   * - admission 起点 `continueShard()`：预解析到的 session（作为初始代次）。
   *
   * `runContinuation()` 在 await 之后**只能在同一代次内补写**自己预解析到的实例，绝不能用
   * 旧实例覆盖 admission 期间安装的新实例（终审 session replacement 竞态的根因）。
   *
   * 路由一致性：每次安装都把「最新 sessionId」写进 sessionRecords（并保留历史 id 用于
   * finishRecord 清理），childId -> childRecords 始终指向同一个 record，因此替换 session
   * 不会让事件路由到别的 record。
   *
   * session 不是对象（冷 child 暂无实例）时不做任何安装，返回 false：路由由调用方按 childId
   * 兜底登记（continueShard），之后 activation 边界会带来真实实例。
   *
   * @returns {boolean} 是否真的安装了新实例（代次 +1）。
   */
  function bindSession(record, session, childId) {
    if (!isObject(session)) return false;
    const fallbackChildId = typeof childId === "string" && childId.length > 0 ? childId : record.childId;
    const sessionId = sessionIdOf(session) ?? fallbackChildId;
    if (session === record.session && sessionId === record.sessionId) return false;
    record.session = session;
    record.sessionGeneration = (Number.isSafeInteger(record.sessionGeneration) ? record.sessionGeneration : 0) + 1;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      record.sessionId = sessionId;
      const ids = record.sessionIds instanceof Set ? record.sessionIds : (record.sessionIds = new Set());
      ids.add(sessionId);
    }
    if (typeof fallbackChildId === "string" && fallbackChildId.length > 0) {
      record.childId = fallbackChildId;
      registerRoute(record, fallbackChildId, record.sessionId);
      rememberChildSession(fallbackChildId, session);
    }
    return true;
  }

  /** session 上的 child 身份：优先 session.header.id（DSH child session 的稳定 id）。 */
  function childIdForSessionIndex(session) {
    const headerId = nonEmptyText(session?.header?.id);
    if (headerId !== "") return headerId;
    return sessionIdOf(session);
  }

  function recordForSession(session) {
    if (typeof session?.id !== "string") return undefined;
    rememberChildSession(childIdForSessionIndex(session), session);
    return sessionRecords.get(session.id) ?? childRecords.get(session.id);
  }

  return {
    // ── 身份登记与查询 ──────────────────────────────────────────────────────
    rememberKnownId,
    rememberChildSession,
    rememberSession,
    isKnownSessionId: (value) => knownIds.has(value),
    isFanoutSessionInstance: (session) => isObject(session) && fanoutSessions.has(session),
    // ── attempt 注册表 ──────────────────────────────────────────────────────
    registerAttempt: (record) => records.set(record.key, record),
    hasAttempt: (key) => records.has(key),
    recordFor: (key) => records.get(key),
    recordForChildId: (childId) => childRecords.get(childId),
    recordForSessionId: (sessionId) => sessionRecords.get(sessionId),
    recordForSession,
    continuationSession,
    registerRoute,
    bindSession,
    forgetRecord,
    activeRecords: () => [...records.values()],
    clearRoutes: () => {
      records.clear();
      childRecords.clear();
      sessionRecords.clear();
    },
    get attemptCount() { return records.size; },
    // ── admission 闸门 ──────────────────────────────────────────────────────
    isClosed: () => state.closed,
    closeGate: () => { state.closed = true; },
    // ── interrupt 判重（有界 attempt key 集合的唯一写面） ───────────────────
    interruptKeyFor,
    isInterrupted: (key) => interruptedKeys.has(key),
    rememberInterrupted,
  };
}

/**
 * 归属判定单元：首轮宽松 fallback、续作严格证明、续作前置条件、身份预检与只读诊断。
 *
 * 全部是只读判定（不写 record、不登记 id、不安装 guard），因此可以安全地在任何
 * manager 状态修改之前被调用。
 */
function createAttributionVerdicts(state, registry) {
  /**
   * 首轮（launcher）attempt 的 turn 归属判定：**保持既有宽松 fallback**。
   *
   * 一个 child 只有一个 launcher attempt，会话级 turn/end 足以认领它；messageId 缺失或该
   * turn 没有可读 user/message 记录时按旧行为结算（不因为新增防线而让既有路径失效）。
   */
  function turnMatchesRecordMessage(record, session, event) {
    const messageId = nonEmptyText(record?.messageId);
    if (messageId === "") return true;
    const turn = turnOf(event);
    if (!Number.isSafeInteger(turn)) return true;
    const ids = messageIdsOfTurn(sessionEventLog(session), turn);
    if (ids.size === 0) return true;
    return ids.has(messageId);
  }

  /**
   * continuation attempt 的 turn 归属判定：**严格证明，不允许任何 fallback**。
   *
   * 多轮复用让多个 attempt 落在同一个 child/session 上，因此必须同时满足：
   * 1. event turn 是有效安全整数；
   * 2. 该 turn 的 user/message id 集合非空（可读的归属证据）；
   * 3. 集合明确包含本轮 admission 返回的 messageId；
   * 4. 该 messageId 与该 attempt 在 manager 里绑定的 messageId 完全一致。
   *
   * 任何一条不成立都返回结构化原因，由调用方保持 attempt 未结算并记录诊断——
   * 旧轮迟到 turn/end、缺 messageId、归属不可读都不会被当成新一轮的终态。
   */
  function continuationAttribution(record, session, event) {
    const turn = turnOf(event);
    if (!Number.isSafeInteger(turn) || turn <= 0) return { ok: false, reason: "invalid_turn" };
    const messageId = nonEmptyText(record?.messageId);
    if (messageId === "") return { ok: false, reason: "continuation_message_id_missing", turn };
    const ids = messageIdsOfTurn(sessionEventLog(session), turn);
    if (ids.size === 0) return { ok: false, reason: "turn_message_ids_unavailable", turn };
    if (!ids.has(messageId)) return { ok: false, reason: "message_id_mismatch", turn, messageId };
    // manager 是 attempt 绑定值的权威来源：读不到或读到别的 id 都按「无法证明归属」处理。
    const bound = state.managerPort.attemptMessageIdOf(record.input?.parentTaskId, record.input?.shardId, record.input?.attempt);
    if (bound === null || bound !== messageId) return { ok: false, reason: "attempt_message_id_mismatch", turn, messageId };
    return { ok: true, turn, messageId };
  }

  /**
   * continuation 的真实执行前置条件（在**任何 manager 状态修改之前**判定）。
   *
   * 只有「投递路由 + 每个分片既有 child 的 session 都可解析」时，续作才可能真正执行；
   * 否则必须先结构化拒绝，不能先返回 accepted 再让 attempt 异步失败（那会破坏回执语义：
   * 用户看到的是一轮被接受的续作，实际上一轮都没跑起来）。
   * 注意：本函数只读，不产生任何副作用。
   */
  function continuationReadiness(task) {
    if (task === null || typeof task !== "object") return { ok: false, reason: "unknown_parent_task", shardIds: [] };
    if (state.hasContinueRoute() !== true) {
      return { ok: false, reason: "continue_route_unavailable", shardIds: [] };
    }
    const shardIds = [];
    for (const shard of Array.isArray(task.shards) ? task.shards : []) {
      const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
      const latest = attempts[attempts.length - 1];
      const childId = nonEmptyText(latest?.childId);
      if (childId === "" || registry.continuationSession(childId) === undefined) {
        shardIds.push(typeof shard?.shardId === "string" ? shard.shardId : "unknown");
      }
    }
    return shardIds.length === 0
      ? { ok: true, shardIds: [] }
      : { ok: false, reason: "child_session_unavailable", shardIds };
  }

  /**
   * fan-out child 身份预检（只读、fail-closed）。
   *
   * 为什么必须独立于 handleAgentCreated：后者的 false 只表示「没有对应的 live attempt」，
   * 它不构成任何身份证据——把别人的 parentTaskId/shardId/attempt 复制过来、或把 parent
   * 指到另一个 root 的错误 marker 同样得到 false，却可能已经被上游当成 fan-out child
   * 登记了 exact Agent 并安装了 scoped guard。因此把一致性判定独立成显式预检，供
   * index.js 在**产生任何副作用之前**调用，handleAgentCreated 自身也复用同一份判定。
   *
   * 判定顺序（每一条不成立都 fail-closed，返回第一个原因）：
   * 1. marker 与持久化 fan-out 身份同时存在时，四个身份字段必须逐字一致；
   * 2. 实际 `agent.parent.id` 存在时必须等于 fan-out parentAgentId；缺失时（合法
   *    cold-resume 的 Agent 可能没有 parent 引用）按可信持久化身份继续判定；
   * 3. 该 attempt 的 active runtime record 存在时，先要求 record 的两个 canonical parent
   *    来源（record.parentId / record.parentAgent.id）彼此一致：两者都非空却不相等即
   *    `fanout_record_parent_conflict`，绝不用集合合并接受单边匹配；一致后再要求
   *    marker/实际 parentAgentId 等于该 canonical parent，覆盖「admission 由 root-a 预备、
   *    created marker/parent 却写 root-b」的 mismatch；record 尚未写入 canonical parent
   *    时同样无从证明，一并拒绝。
   *
   * 只读：不写 record、不登记 id、不安装任何 guard。
   *
   * @param {object} agent - agent/created 携带的 exact Agent。
   * @param {object} [persistedIdentity] - 该 child id 的持久化模型快照（可选）。
   * @returns {{ok:true, identity:object} | {ok:false, reason:string}}
   */
  function precheckChildIdentity(agent, persistedIdentity) {
    const markerIdentity = markerFanoutIdentity(markerOptions(agent));
    const persisted = persistedFanoutIdentity(persistedIdentity);
    if (markerIdentity === undefined && persisted === undefined) {
      return { ok: false, reason: "fanout_identity_missing" };
    }
    if (markerIdentity !== undefined && persisted !== undefined) {
      for (const field of FANOUT_IDENTITY_FIELDS) {
        if (markerIdentity[field] !== persisted[field]) {
          return { ok: false, reason: "fanout_identity_conflict:" + field };
        }
      }
    }
    const identity = markerIdentity ?? persisted;
    const actualParentId = nonEmptyText(agent?.parent?.id);
    if (actualParentId !== "" && actualParentId !== identity.parentAgentId) {
      return { ok: false, reason: "fanout_parent_agent_mismatch" };
    }
    const record = registry.recordFor(fanoutAttemptKey(identity.parentTaskId, identity.shardId, identity.attempt));
    if (record !== undefined) {
      // canonical parent 只取 admission 边界写入的两个来源（record.parentId / record.parentAgent.id）。
      const recordParentId = nonEmptyText(record.parentId);
      const recordParentAgentId = nonEmptyText(record.parentAgent?.id);
      // 两个来源都非空却不相等：record 自身的父归属自相矛盾。此时**不能**合并成集合后接受
      // 「单边匹配」——那等于让伪造方挑一个对自己有利的来源当证据。矛盾必须先于匹配拒绝。
      if (recordParentId !== "" && recordParentAgentId !== "" && recordParentId !== recordParentAgentId) {
        return { ok: false, reason: "fanout_record_parent_conflict" };
      }
      // 只有两个来源一致（或仅一个可用）时才存在唯一 canonical parent；两者都缺失时没有
      // 任何可证明的归属，同样 fail-closed（绝不用 marker 自己的值给自己作证）。
      const canonicalParentId = recordParentId !== "" ? recordParentId : recordParentAgentId;
      if (canonicalParentId === "") return { ok: false, reason: "fanout_record_parent_unproven" };
      if (canonicalParentId !== identity.parentAgentId) return { ok: false, reason: "fanout_record_parent_mismatch" };
      if (actualParentId !== "" && actualParentId !== canonicalParentId) {
        return { ok: false, reason: "fanout_record_parent_mismatch" };
      }
    }
    return { ok: true, identity };
  }

  /** agent/created 回调里的角色投影：marker 上的专家角色，缺失时由调用方回落到持久化身份。 */
  function expertRoleOf(agent) {
    return markerText(markerOptions(agent), "__degExpertRole");
  }

  /** 父任务所属的 exact root Agent（身份解析；未接线时返回 undefined）。 */
  function resolveParentAgent(parentTaskId) {
    return typeof state.parentAgentOf === "function" ? state.parentAgentOf(parentTaskId) : undefined;
  }

  /**
   * 只读诊断：某 attempt 当前的会话绑定状态（sessionId / 安装代次 / 是否有实例 / 阶段 /
   * 是否有 admission 期间的 disposal 待决标记 / 已忽略的迟到 disposal 数）。
   *
   * 用途是验证两轮终审修复的可观测不变式：latest-session 规则（replacement 后写回不得推进/
   * 回退代次）与 disposal 替换窗口（未绑定的 continuation admission 不得被旧实例 disposal
   * 提前终结）。返回普通标量，不暴露 session/Agent 对象引用。
   */
  function sessionBindingOf(parentTaskId, shardId, attemptNumber) {
    const record = registry.recordFor(fanoutAttemptKey(parentTaskId, shardId, attemptNumber));
    if (record === undefined) return null;
    return {
      sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
      generation: Number.isSafeInteger(record.sessionGeneration) ? record.sessionGeneration : 0,
      hasInstance: isObject(record.session),
      phase: typeof record.phase === "string" ? record.phase : null,
      pendingDisposal: record.pendingDisposal !== undefined,
      staleDisposalIgnored: Number.isSafeInteger(record.staleDisposalIgnored) ? record.staleDisposalIgnored : 0,
      replacedAfterDisposal: Number.isSafeInteger(record.replacedAfterDisposal) ? record.replacedAfterDisposal : 0,
    };
  }

  return {
    turnMatchesRecordMessage,
    continuationAttribution,
    continuationReadiness,
    precheckChildIdentity,
    expertRoleOf,
    resolveParentAgent,
    sessionBindingOf,
  };
}

/**
 * 归属老化单元（票据 07）：观察窗口、到期后调用 manager 精确 API 标记 needs_attention，
 * 以及只读诊断计数。语义边界：老化只说明「归属无法证明且超过宽限」，**不**证明执行已停止，
 * 因此 record 作为 tombstone 保留，等迟到证据到达后按正常路径收敛。
 */
function createAttributionAging(state) {
  const { managerPort, log, agingNow, agingSetTimeout, agingClearTimeout, attributionAgingMs } = state;

  /**
   * 清除 record 的归属老化定时器（生命周期终点：finish/close）。
   *
   * 必须在 record 生命周期结束时调用：否则已结算的 attempt 仍会在宽限到期时触发一次
   * manager 调用（对已终态 attempt 是 no-op，但会留下无意义的诊断与悬挂句柄）。
   *
   * @returns {boolean} 是否真的清理了一个待决定时器。
   */
  function releaseAgingTimer(record) {
    if (record?.attributionAgingTimer === undefined) return false;
    try { agingClearTimeout(record.attributionAgingTimer); } catch (error) { log("fan-out attribution aging clear failed", error); }
    record.attributionAgingTimer = undefined;
    state.attributionAgingPending = Math.max(0, state.attributionAgingPending - 1);
    return true;
  }

  /**
   * 首次观察到"归属无法证明"时启动老化窗口（同一 record 只启动一次）。
   *
   * 语义边界：这只记录观察窗口，**不**改变 attempt 状态、不请求取消、不释放范围。
   * 到期后由 runAging 调用 manager 的精确 API；在此之前任何合法 completion /
   * disposal 仍按原路径收敛，并由 finishRecord 清掉定时器。
   */
  function scheduleAging(record) {
    if (attributionAgingMs <= 0) return false;
    if (record === undefined || record.finished === true) return false;
    if (record.attributionAgingTimer !== undefined) return false;
    const firstAt = agingNow();
    record.attributionUnprovenFirstAt = firstAt;
    record.attributionAgingDeadlineAt = firstAt + attributionAgingMs;
    // 先记账再注册：注入的 setTimeout 若是同步执行（测试替身/极端实现），回调里的
    // 递减必须能看到这一笔，否则 pending 会永久多 1。同步触发后不得再把句柄写回去。
    state.attributionAgingPending += 1;
    let firedSynchronously = false;
    try {
      const timer = agingSetTimeout(() => {
        firedSynchronously = true;
        // 假时钟可能在触发前不删除句柄；这里统一清账，保证 pending 计数不漂移。
        record.attributionAgingTimer = undefined;
        state.attributionAgingPending = Math.max(0, state.attributionAgingPending - 1);
        runAging(record);
      }, attributionAgingMs);
      // null 表示"已注册但宿主未返回可清除句柄"：仍算 pending，release 时会清账。
      record.attributionAgingTimer = firedSynchronously ? undefined : (timer === undefined ? null : timer);
      // unref：归属老化只是 fail-closed 诊断，不应把测试/宿主进程按 60 秒钉住。
      if (!firedSynchronously) timer?.unref?.();
    } catch (error) {
      // 定时器注册失败不能把事件处理打断：清账并保持 record 原状（等迟到证据/关闭）。
      state.attributionAgingPending = Math.max(0, state.attributionAgingPending - 1);
      record.attributionAgingTimer = undefined;
      log("fan-out attribution aging schedule failed", error);
      return false;
    }
    return true;
  }

  /**
   * 老化到期：用 manager 的权威身份把仍非终态的 attempt 标记为 needs_attention。
   *
   * 为什么不在到期时先 finishRecord：aging 只说明"归属无法证明且超过宽限"，**不**证明
   * 执行已停止。因此 record 作为 tombstone 保留，等迟到 completion/disposal 证据到达后
   * 再按正常路径收敛（manager 只会补证据、不改终态）。
   */
  function runAging(record) {
    if (state.closed || record.finished === true) return false;
    const input = isObject(record.input) ? record.input : {};
    const parentTaskId = nonEmptyText(input.parentTaskId);
    const shardId = nonEmptyText(input.shardId);
    const attemptNumber = attemptValue(input.attempt);
    if (parentTaskId === "" || shardId === "" || attemptNumber === undefined) {
      state.attributionAgingSkippedCount += 1;
      return false;
    }
    let identity = null;
    try {
      identity = managerPort.attemptIdentityOf(parentTaskId, shardId, attemptNumber);
    } catch (error) {
      log("fan-out attribution identity lookup failed", error);
      identity = null;
    }
    if (identity === null) {
      // 任务/分片/attempt 已不存在（例如被 close 清理）：没有可标记的对象，保持静默。
      state.attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = "attempt_identity_unavailable";
      return false;
    }
    let result;
    try {
      result = managerPort.markAttributionAged({
        parentTaskId,
        shardId,
        attempt: attemptNumber,
        attemptId: identity.attemptId,
        executionGeneration: identity.executionGeneration,
      }, { reason: "shard_attribution_unproven_aged" });
    } catch (error) {
      log("fan-out attribution aging failed", error);
      state.attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = "manager_call_failed";
      return false;
    }
    if (result?.changed !== true) {
      // 已终态（迟到 completion 先到）或身份过期：no-op，不产生任何状态变更。
      state.attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = typeof result?.reason === "string" ? result.reason : "not_changed";
      return false;
    }
    state.attributionAgingAgedCount += 1;
    const agedAt = agingNow();
    record.attributionAgedAt = agedAt;
    record.attributionAgedReason = typeof result.terminalReason === "string"
      ? result.terminalReason
      : "shard_attribution_unproven_aged";
    state.lastAttributionAged = {
      parentTaskId,
      shardId,
      attempt: attemptNumber,
      attemptId: identity.attemptId,
      executionGeneration: identity.executionGeneration,
      at: agedAt,
      status: result.status,
      taskStatus: result.taskStatus,
      reason: "shard_attribution_unproven_aged",
      needsAttention: true,
    };
    log("fan-out attribution aged: " + JSON.stringify({
      parentTaskId,
      shardId,
      attempt: attemptNumber,
      status: result.status,
      taskStatus: result.taskStatus,
    }));
    return true;
  }

  /**
   * 记录一次「continuation 归属无法证明」的结构化诊断。
   *
   * 每个 record（= 一个 attempt 的一轮投递）对**同一种原因**最多报告一次，避免异常 child
   * 反复发 turn/end 造成事件抖动；不同原因（缺消息号 / 消息号不一致 / turn 非法 …）各自
   * 独立留证，便于定位竞态的真实形态。事件由 manager 发布（进事件历史/持久化/RPC）。
   */
  function reportViolation(record, verdict) {
    const reason = typeof verdict?.reason === "string" && verdict.reason.length > 0 ? verdict.reason : "unproven";
    const reported = record.attributionDiagnosticReasons instanceof Set
      ? record.attributionDiagnosticReasons
      : (record.attributionDiagnosticReasons = new Set());
    if (reported.has(reason)) return;
    reported.add(reason);
    const payload = {
      parentTaskId: record.input?.parentTaskId,
      shardId: record.input?.shardId,
      attempt: record.input?.attempt,
      reason,
      ...(Number.isSafeInteger(verdict?.turn) ? { turn: verdict.turn } : {}),
      ...(typeof verdict?.messageId === "string" ? { messageId: verdict.messageId } : {}),
    };
    try {
      managerPort.recordAttributionViolation(payload);
    } catch (error) {
      log("fan-out attribution diagnostic failed", error);
    }
    // 首次无法证明归属即启动老化窗口：到期后只标记 needs_attention，不猜测停止。
    scheduleAging(record);
    log("fan-out continuation attribution unproven: " + JSON.stringify(payload));
  }

  /**
   * 老化诊断投影（只读）：enabled / windowMs / pending / aged / skipped / lastAged。
   * 与拆分前 stopDiagnostics().aging 逐字段一致。
   */
  function stopDiagnosticsAging() {
    return {
      enabled: attributionAgingMs > 0,
      windowMs: attributionAgingMs,
      pending: state.attributionAgingPending,
      aged: state.attributionAgingAgedCount,
      skipped: state.attributionAgingSkippedCount,
      lastAged: state.lastAttributionAged === null ? null : cloneJson(state.lastAttributionAged),
    };
  }

  return { releaseAgingTimer, scheduleAging, reportViolation, stopDiagnosticsAging };
}

/**
 * 创建归属服务。
 *
 * 参数是**协作方**而不是任意参数袋（口径见规格书 C3）：
 * - `log`：日志旁路；
 * - `managerPort`：manager 的归属权威读写面（attemptMessageIdOf / attemptIdentityOf /
 *   markAttributionAged / recordAttributionViolation）——同一协作方，注入时已晚绑定；
 * - `clock`：老化定时器与时钟（now / setTimeout / clearTimeout）；
 * - `attributionAgingMs`：原始配置值；
 * - `resolveChildSession`：宿主解析既有 child session 的适配器；
 * - `parentAgentOf`：宿主解析父任务 root Agent 的适配器（父身份归属）；
 * - `hasContinueRoute`：续作投递路由是否接线（只读探针，保持原「调用时判定」语义）。
 *
 * 工厂本体只做单元装配（注册表 / 判定 / 老化），逻辑分别在三个单元工厂里；每个单元都
 * 接收同一个 `state`，因此 Map/Set 的唯一 owner 仍是本文件。
 *
 * @returns {object} 归属服务的命令面 + 只读投影。
 */
export function createFanoutAttribution(deps = {}) {
  const state = createAttributionState(deps);
  const registry = createAttributionRegistry(state);
  const verdicts = createAttributionVerdicts(state, registry);
  const aging = createAttributionAging(state);
  return {
    ...registry,
    ...verdicts,
    ...aging,
    /** 活动 attempt 数（注册表只读投影；getter 保证实时）。 */
    get attemptCount() { return registry.attemptCount; },
  };
}
