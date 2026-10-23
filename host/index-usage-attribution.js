/**
 * 入口用量归属 + 账本接线域（R4c · 票据 17，承接票据 16 遗留的 284 行）。
 *
 * 这一域持有**用量域**的全部可变状态：
 * - `usageLedger`：有界用量账本（sessions/stats/disposed 与唯一 timer 由它独占）；
 * - `dispatchAcceptedClock`：admission 侧单调 acceptedAt 计数器（同一次 dispatch 严格递增）。
 *
 * ## 为什么与 settings/storage 分开（票据 16 的取舍）
 * ① 关注点是「用量域」而不是 settings/storage；② 它依赖 recoveryRecords（R4c 的 owner）、
 * agents、shadowMarkerFields 与 flushPendingStructuredPatch，纳入 R4b 会把该域工厂推到
 * 9–10 个能力组；③ persistChildDispatch 的 acceptedAt 计数器与 storage 写命令不同生命周期。
 *
 * ## 组合根保留的职责（铁律 1）
 * `ctx.on("session/event")`、`ctx.on("agent/disposed")` 与 `ctx.effect(usage ledger dispose)`
 * 的注册语句与顺序仍在 `index.js` 的原注册点：本模块只返回 handler（observeUsageEvent /
 * finishUsage / disposeUsageLedger）与只读投影。域服务**不接收 ctx**。
 *
 * ## 行为等价
 * 归属证据优先级（child_models -> recovery record -> live Agent/marker）、账本订阅面、
 * 刷盘去抖与失败告警、投影分块与上限全部与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-usage-attribution
 */
import { isFanoutAgent, isFanoutIdentity } from "../fanout-host.js";
import { createUsageLedger } from "./usage-ledger.js";
import {
  MAX_RECENT_USAGE_TASKS,
  hasUsageMetrics,
  projectUsage,
  summarizeUsage,
} from "./usage-projection.js";
import {
  EXPERT_INHERIT_CONTEXT_MARKER,
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
} from "../shared/model-route.js";
import { OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";
import { EFFORT_MARKER, PARENT_MARKER, ROLE_MARKER } from "./expert-guards.js";
import { firstNonEmptyText } from "./settings-read-projection.js";
import { shadowMarkerFields } from "./send-message-shadow.js";

/**
 * 创建用量归属 / 账本接线域能力面。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx）。
 * @param {object} deps.logger - 宿主 logger（账本旁路告警只记固定类别）。
 * @param {object} deps.records - recovery 记录只读读面（getRecord）。
 * @param {object} deps.storage - settings/storage 域（读快照 + child_models 写命令 + binding 缓存快照）。
 * @param {object} deps.agents - agents registry（live Agent 身份兜底）。
 * @param {object} deps.lineage - root 代次表（activeRoot 的 O(1) 排除）。
 * @param {object} deps.roles - 角色目录投影（roleLabelOfRole）。
 * @param {object} deps.childModelPatch - child_models 补写所需的组合根纯函数与结构化刷写命令。
 * @returns {object} 用量归属 / 账本能力面。
 */
export function createIndexUsageAttributionDomain(deps) {
  const api = {};
  Object.assign(api, installUsageAttribution(deps, api));
  Object.assign(api, installDispatchPersistence(deps, api));
  return { ...api };
}

/**
 * U1：归属解析、用量账本接线与只读投影。
 *
 * 账本实例是这一组的唯一可变状态（createUsageLedger 持有 sessions/stats/disposed 与唯一 timer）。
 * 域外只能经 observeUsageEvent / finishUsage / collectUsageEntries / usageSummaryFor / usageFor
 * 访问；ctx.on / ctx.effect 的注册点仍在 index.js 的原注册点（铁律 1）。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 用量归属与账本能力面。
 */
function installUsageAttribution(deps) {
  const { logger, records, storage, agents, lineage, roles } = deps;
  const { readSnapshot, writeChildModelPatch, domainSnapshot } = storage;
  const { roleLabelOfRole } = roles;
  const { getRecord } = records;

  /**
   * 用量归属解析（票据 25）。
   *
   * 归属只从 DEG 自己的记录读取，绝不从事件负载猜测：
   * - 首选 child_models（重启后仍可读，含 role/roleLabel/provider/model/fallbackCount）；
   * - 其次 recoveryRecords（live/可续作 child 的进程内记录）；
   * - 最后用 live Agent 的 role/parent marker 与 requestHeader.config 兜底。
   *
   * 返回 undefined 表示“这不是 DEG 的 child 会话”：root、普通会话、真正未知的会话都
   * 不计入账本，避免把父会话或宿主其它会话的用量记到专家任务上。
   * 返回对象只含归属字段，不含 prompt/response/凭据/路径。
   *
   * @param {string} sessionId - 事件所属会话 id。
   * @returns {{role?:string, roleLabel?:string, provider?:string, model?:string, fallbackCount?:number}|undefined}
   */
  function usageAttributionOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    // 快路径：storage-binding 已缓存 domain 快照（与 readSnapshot() 的 childModels 同一份事实），
    // 但读取是 O(1) Map 查表；绝不能在每个 assistant 事件上重跑 readSnapshot()。
    let persisted;
    try { persisted = domainSnapshot()?.childModels?.[sessionId]; } catch { persisted = undefined; }
    const record = getRecord(sessionId);
    let agent;
    try { agent = agents?.get?.(sessionId); } catch { agent = void 0; }
    let role = firstNonEmptyText(
      persisted?.role,
      record?.role,
      agent?.options?.[ROLE_MARKER],
    );
    let parentId = firstNonEmptyText(
      persisted?.parentId,
      record?.parentId,
      agent?.options?.[PARENT_MARKER],
    );
    // fan-out child 的身份可能只有 fan-out marker（role/parentId 仍会写入 child_models，
    // 但 cold/异常记录不一定完整）：任何 fan-out 证据都视为 DEG child。
    let fanoutChild = persisted?.fanout === true
      || isFanoutAgent(agent)
      || isFanoutIdentity(persisted)
      || isFanoutIdentity(record);
    const hasEvidence = persisted !== undefined || record !== undefined || fanoutChild
      || role !== null || parentId !== null;
    if (!hasEvidence) {
      // live root 的 assistant 事件不属于任何 expert child：先用 lineage 的 O(1) 查询
      // 排除，避免每个 root 消息都触发一次 storage 快照读取。
      let currentRoot;
      try { currentRoot = lineage.activeRoot(sessionId); } catch { currentRoot = undefined; }
      if (currentRoot !== undefined) return undefined;
      // 还没有任何进程内证据的会话（典型是 live agent 尚未登记、或测试替身没有把 child
      // 放进 agents registry）：读一次权威 domain 快照确认它是否是已知 child。
      // 这条路径只对“非 root 且无 marker”的会话生效，root 已在上面提前返回。
      try { persisted = readSnapshot()?.childModels?.[sessionId]; } catch { persisted = undefined; }
      if (persisted === undefined) return undefined;
      fanoutChild = persisted?.fanout === true || isFanoutIdentity(persisted);
      role = firstNonEmptyText(role, persisted?.role);
      parentId = firstNonEmptyText(parentId, persisted?.parentId);
    } else if (persisted === undefined) {
      // 已证明是 child、但缓存里还没有它的记录：补一次权威快照。
      try { persisted = readSnapshot()?.childModels?.[sessionId]; } catch { persisted = undefined; }
      role = firstNonEmptyText(role, persisted?.role);
      parentId = firstNonEmptyText(parentId, persisted?.parentId);
    }
    let header;
    try { header = agent?.session?.requestHeader?.(); } catch { header = undefined; }
    const config = header?.config;
    // 显示名跟随当前角色目录（内置角色已统一为英文）；仅当角色已删除（目录里没有该 id）时
    // 才回退 child_models 的持久化快照，保证历史任务仍有标签可显示。
    const roleLabel = firstNonEmptyText(role === null ? null : roleLabelOfRole(role), persisted?.roleLabel);
    const provider = firstNonEmptyText(persisted?.provider, config?.provider, agent?.options?.provider);
    const model = firstNonEmptyText(persisted?.model, config?.model, agent?.options?.model);
    return {
      ...(role === null ? {} : { role }),
      ...(roleLabel === null ? {} : { roleLabel }),
      ...(provider === null ? {} : { provider }),
      ...(model === null ? {} : { model }),
      ...(Number.isSafeInteger(persisted?.fallbackCount) && persisted.fallbackCount >= 0
        ? { fallbackCount: persisted.fallbackCount }
        : {}),
    };
  }

  /**
   * 用量账本实例（票据 25）。
   *
   * 只订阅 live session/event，不在任何路径上从快照/投影回填：fork 子会话的继承前缀
   * 不会重新发布事件，种子/恢复也不会，因此不会重复计数。刷盘通过既有
   * writeChildModelPatch 合并写 child_models.usage（turn/end、agent/disposed 立即写，
   * 普通事件按 200ms 去抖合并），写失败只告警，不影响 child 生命周期。
   */
  const usageLedger = createUsageLedger({
    // rethrow=true：账本必须能感知失败，才能保留 dirty 并在有界预算内重试；
    // writeChildModelPatch 默认吞掉失败，会让账本误以为样本已落盘。
    persist: (childId, usage) => writeChildModelPatch(childId, { usage }, { rethrow: true }),
    logger: logger,
  });
  /**
   * 卸载：清定时器并尽量把最后一个脏条目写出去（返回的 promise 不阻塞卸载）。
   * ctx.effect 注册点仍在组合根的原注册点（铁律 1）。
   */
  function disposeUsageLedger() { void usageLedger.dispose(); }

  /**
   * 专用 session/event 处理（票据 25）。ctx.on 注册点仍在组合根（铁律 1）。
   *
   * 与既有 fanout/recovery/快照失效监听**并列**，不替换、不改变它们的语义：
   * - assistant/message：请求数 + usage（data.usage 优先，其次 stream 最后一个 usage chunk）；
   * - assistant/attempt：重试数 + stream usage；
   * - llm/retry-started（可选宿主能力）：与 attempt 按 (turn, step) 合并，避免双计；
   * - turn/end：补 finishedAt 并立即刷盘。
   * 只处理能被 DEG 归属证明为 child 的会话；root 与陌生会话直接跳过。
   */
  function observeUsageEvent(session, event) {
    const type = event?.type;
    if (type !== "assistant/message" && type !== "assistant/attempt"
      && type !== "llm/retry-started" && type !== "turn/end") return;
    if (typeof session?.id !== "string" || session.id.length === 0) return;
    try {
      const attribution = usageAttributionOf(session.id);
      if (attribution === undefined) return;
      usageLedger.observe(session, event, attribution);
    } catch (error) {
      // 账本是旁路统计：任何异常都不得影响 session 事件派发或 child 生命周期。
      logger.warn("dsh-expert-group: usage ledger observe failed: "
        + (error instanceof Error ? error.message : String(error)));
    }
  };

  /**
   * agent/disposed 是 child 的稳定结束边界：补 finishedAt 并立即刷盘。
   * 只对账本里已有的 session 生效（restore 出来的旧 child 没有 live 事件，不写空值）。
   * ctx.on 注册点仍在组合根（铁律 1）。
   */
  function finishUsage(agent) {
    if (typeof agent?.id !== "string") return;
    try { void usageLedger.finish(agent.id); } catch (error) {
      logger.warn("dsh-expert-group: usage ledger finish failed: "
        + (error instanceof Error ? error.message : String(error)));
    }
  };
  /**
   * 收集某个 root（或全局）的用量条目（票据 25，只读）。
   *
   * 数据源以 child_models.usage 为准（重启/恢复后可读），再用 live 账本覆盖同一 child
   * 的最新值（去抖窗口内尚未落盘的样本也能被 RPC 读到）。归属（role/provider/model）
   * 取持久化记录优先，缺失时回落到进程内 recovery record；不读取 prompt/response。
   *
   * @param {string|null} rootId - 限定 root；null/空表示全局（RPC meta）。
   * @returns {Array<{childId:string, role?:string, roleLabel?:string, provider?:string, model?:string, usage:object}>}
   */
  function collectUsageEntries(rootId = null) {
    const scope = typeof rootId === "string" && rootId.length > 0 ? rootId : null;
    const persisted = (() => {
      try { return readSnapshot()?.childModels ?? {}; } catch { return {}; }
    })();
    const entries = new Map();
    for (const [childId, record] of Object.entries(persisted)) {
      if (scope !== null && record?.parentId !== scope) continue;
      const usage = projectUsage(record?.usage);
      if (usage === null || hasUsageMetrics(usage) === false) continue;
      entries.set(childId, {
        childId,
        role: record?.role,
        roleLabel: record?.roleLabel,
        provider: record?.provider,
        model: record?.model,
        usage,
      });
    }
    // live 账本覆盖：同一 child 只保留最新累积值；按 parentId 做 root 过滤。
    for (const entry of usageLedger.entries()) {
      const record = persisted[entry.childId];
      const recordParent = record?.parentId ?? getRecord(entry.childId)?.parentId;
      if (scope !== null && recordParent !== scope) continue;
      const usage = projectUsage(entry.usage);
      if (usage === null || hasUsageMetrics(usage) === false) continue;
      entries.set(entry.childId, {
        childId: entry.childId,
        role: record?.role ?? getRecord(entry.childId)?.role,
        roleLabel: record?.roleLabel,
        provider: record?.provider,
        model: record?.model,
        usage,
      });
    }
    return [...entries.values()];
  }

  /**
   * 有界用量摘要（票据 25）。
   *
   * 输出固定四块：totals / byRole / byProvider / byModel / recentTasks（最多 16）。
   * 没有有效样本时 totals 为 null、分组为空、recentTasks 为空——绝不补 0。
   * recentTasks 只含角色/模型与 usage，不含 childId、prompt、response、凭据或路径。
   *
   * @param {string|null} rootId - 限定 root；null = 全局（meta）。
   * @returns {{totals:object|null, byRole:object, byProvider:object, byModel:object, recentTasks:object[]}}
   */
  function usageSummaryFor(rootId = null) {
    try {
      return summarizeUsage(collectUsageEntries(rootId), { recentLimit: MAX_RECENT_USAGE_TASKS });
    } catch (error) {
      logger.warn("dsh-expert-group: usage summary projection failed: "
        + (error instanceof Error ? error.message : String(error)));
      return { totals: null, byRole: {}, byProvider: {}, byModel: {}, recentTasks: [] };
    }
  }

  return {
    observeUsageEvent,
    finishUsage,
    disposeUsageLedger,
    collectUsageEntries,
    usageSummaryFor,
    /** live 账本读面（runtime 投影只读，不参与计量与刷盘）。 */
    usageFor: (childId) => usageLedger.usageFor(childId),
  };
}

/**
 * U2：admission 成功后的 dispatch 描述旁路写回（child_models 可见性）。
 *
 * dispatchAcceptedClock 是 admission 侧单调计数器：同一次 dispatch 的 acceptedAt 必须严格
 * 递增，否则 child_models 的「迟到写入不覆盖新值」判定会失效。它与 storage 写命令不同生命周期，
 * 因此随本组一起迁移（票据 16 遗留项，票据 17 一并收口）。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} dispatch 持久化能力面。
 */
function installDispatchPersistence(deps) {
  const { agents, storage, roles, childModelPatch } = deps;
  const { writeChildModelPatch } = storage;
  const { roleLabelOfRole } = roles;
  const { routeFieldsOfMarker, structuredRequestedOfRequest, validSubagentProviderName, flushPendingStructuredPatch } = childModelPatch;

  /**
   * admission 时间单调计数器：同一次 dispatch 的 acceptedAt 必须严格递增，
   * 否则 child_models 的「迟到写入不覆盖新值」判定会失效。
   *
   * 它只服务 persistChildDispatch（admission 侧），因此 owner 仍是组合根，不随
   * storage 写命令迁移（票据 16：storage 写命令不持有 admission 状态）。
   */
  let dispatchAcceptedClock = 0;

  /**
   * 在 admission 已成功后把最新 dispatch 描述旁路写回既有 child_models 记录。
   * 写入读取与合并均在串行临界区内完成，不建立第二套任务表。
   */
  function persistChildDispatch(childId, record, request, label, messageId) {
    if (typeof childId !== "string" || childId.length === 0) return;
    const pickText = (...values) => {
      for (const value of values) if (typeof value === "string" && value.trim().length > 0) return value.trim();
      return null;
    };
    let agent = record?.agent;
    if (agent === void 0) {
      try { agent = agents?.get?.(childId); } catch { agent = void 0; }
    }
    const provider = pickText(agent?.options?.provider);
    const model = pickText(agent?.options?.model);
    if (provider === null || model === null) return;
    const prompt = request?.prompt?.[0]?.text;
    const acceptedAt = Math.max(Date.now(), dispatchAcceptedClock + 1);
    dispatchAcceptedClock = acceptedAt;
    // 实际路由元数据来自 admission 请求上的 marker：它与 agentOptions 同一份值，
    // 保证 agent/created 与后续 dispatch patch 都不会丢掉 candidateIndex/fallbackCount。
    const routeFields = routeFieldsOfMarker(request?.agentOptions?.[EXPERT_ROUTE_MARKER]);
    // 目标 subagent provider 与继承开关（票据 29）：请求上的内部字段 / marker 优先，
    // 其次已持久化记录或 live agent options。缺失时省略，绝不伪造 false。
    const subagentProvider = pickText(
      validSubagentProviderName(request?.subagentProvider),
      validSubagentProviderName(request?.agentOptions?.[EXPERT_SUBAGENT_PROVIDER_MARKER]),
      validSubagentProviderName(record?.subagentProvider),
      validSubagentProviderName(agent?.options?.[EXPERT_SUBAGENT_PROVIDER_MARKER]),
    );
    const inheritContext = (() => {
      for (const value of [
        request?.agentOptions?.[EXPERT_INHERIT_CONTEXT_MARKER],
        record?.inheritContext,
        agent?.options?.[EXPERT_INHERIT_CONTEXT_MARKER],
      ]) {
        if (typeof value === "boolean") return value;
      }
      return void 0;
    })();
    writeChildModelPatch(childId, {
      provider,
      model,
      ...routeFields,
      ...(typeof agent?.options?.[EFFORT_MARKER] === "string" ? { reasoningEffort: agent.options[EFFORT_MARKER] } : {}),
      ...(pickText(record?.role, agent?.options?.[ROLE_MARKER]) !== null ? { role: pickText(record?.role, agent?.options?.[ROLE_MARKER]) } : {}),
      // 角色显示名（票据 27）：续作/恢复补写时保持历史标签可读；未知角色不写。
      ...(pickText(roleLabelOfRole(pickText(record?.role, agent?.options?.[ROLE_MARKER]))) !== null
        ? { roleLabel: roleLabelOfRole(pickText(record?.role, agent?.options?.[ROLE_MARKER])) }
        : {}),
      ...(pickText(record?.parentId, agent?.options?.[PARENT_MARKER]) !== null ? { parentId: pickText(record?.parentId, agent?.options?.[PARENT_MARKER]) } : {}),
      ...(subagentProvider === null ? {} : { subagentProvider }),
      ...(inheritContext === void 0 ? {} : { inheritContext }),
      // 结构化交付（票据 30）：保留“本次/历史声明过 outputSchema”的布尔；
      // schema 原文与 structured 结果都不在这里重写（结果由后台捕获 patch 写入）。
      ...(structuredRequestedOfRequest(request) || record?.outputSchemaRequested === true
        ? { outputSchemaRequested: true }
        : {}),
      continuable: true,
      // shadow 生效性判定快照（与 deny/persona 同层 marker）：只在有判定结果时写入，
      // 该 child 的进程内状态映射被释放后不再补写（durable 记录保留最后一次判定）。
      ...shadowMarkerFields(childId),
      lastDispatch: {
        description: typeof label === "string" ? label : void 0,
        prompt: typeof prompt === "string" ? prompt : void 0,
        messageId: typeof messageId === "string" ? messageId : void 0,
        acceptedAt,
      },
    }).then(() => flushPendingStructuredPatch(childId));
  }

  return { persistChildDispatch };
}
