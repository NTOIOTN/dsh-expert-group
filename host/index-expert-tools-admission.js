/**
 * 入口 role 工具的 admission 域（R4d · 票据 18）。
 *
 * 这一域承载 role-named 专家工具在 `execute` 里真正会走到的委派语义：
 * - 显式句柄（childId / cancelChildId）的归属校验与可读拒绝；
 * - 多 child 语义的复用/续作/重建/取消（与自动恢复共用同一条重建路径）；
 * - 新 child 事务（pending creation 预登记、acceptance 回填、失败回滚）；
 * - 冷启动快照恢复与 scope 临界区预检/活动登记。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**、不做任何注册；`ctx.effect` / `tools.register` 与 disposer
 * 顺序仍由 `index.js` 在原注册点执行（role 工具定义对象由 `index-expert-tools-role` 构造）。
 *
 * ## 状态唯一 owner
 * 本模块不持有可跨调用状态：每个 `forRole(role)` 每次挂载生成一组**只读闭包**，
 * 其中没有 Map/Set/计数器；任务绑定、recovery record、handoff admission 的容器分别由
 * 各自的域 owner 持有，这里只调用命令。
 *
 * ## 行为等价
 * 判定顺序（显式续作 → 相同任务复用 → 快照恢复 → 新建）、lineage 复查点、容量错误
 * 翻译、supersede 边界与回滚事务全部与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-expert-tools-admission
 */
import { createSubagentCapacityError } from "../shared/capacity-errors.js";
import {
  CONTEXT_INHERITANCE_ERROR_CODES,
  EXPERT_INHERIT_CONTEXT_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
} from "../shared/model-route.js";
import { OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";
import { TASK_BINDING_LIMIT, evictOldestEntries } from "../shared/recovery-ledger.js";
import { isFanoutAgent, isFanoutIdentity } from "../fanout-host.js";
import { registerPluginExpertChildAgent } from "./expert-guards.js";

/**
 * 句柄校验、scope 已知 child 枚举与显式取消（role 闭包，无状态）。
 *
 * @param {object} deps - 窄能力面（5 组：delegation / records / agents / storage / subagents）。
 * @returns {object} `forRole(role)` 能力。
 */
export function createRoleToolHandles({ delegation, records, agents, storage, subagents }) {
  const delegationTracker = delegation;
  const { getRecord, recordEntries } = records;

  function forRole(role) {
  /**
   * 校验显式续作句柄（role tool 的 childId）：必须存在、属于当前 root，
   * 并且是本 scope 记录过的 expert child。
   *
   * 只接受显式传入的 childId —— 没有任何输入时绝不把「当前 scope 最近一个
   * child」当成续作目标，避免不同 prompt 被静默当成旧任务的续作。
   * @returns {{target:object|undefined, warning:string}} 校验结果。
   */
  function resolveContinueTarget({ childId, parent, scope, taskKey, currentRouteKey }) {
    if (typeof childId !== "string" || childId.length === 0) {
      return { target: void 0, warning: role + " 续作需要显式 childId" };
    }
    if (!trackerChildIdsForScope(scope, taskKey, { parent }).includes(childId)) {
      return {
        target: void 0,
        warning: role + " 续作被拒绝：childId 「" + childId + "」不是本 root(" + parent.id + ") 下该角色的已知专家 child；"
          + "请使用 role 工具返回的 subagentId，或省略 childId 派发一个新任务",
      };
    }
    const record = getRecord(childId);
    // 记录存在时进一步校验 owner：跨父代理/跨角色的 childId 不得被当作续作目标。
    if (record !== void 0 && (record.parentId !== parent.id || (record.role !== void 0 && record.role !== role))) {
      return {
        target: void 0,
        warning: role + " 续作被拒绝：childId 「" + childId + "」不属于当前 root 的该角色专家 child",
      };
    }
    const bound = delegationTracker.getTaskChild(scope, taskKey);
    return {
      target: {
        childId,
        record,
        routeKey: bound?.childId === childId && typeof bound.routeKey === "string" ? bound.routeKey : currentRouteKey,
      },
      warning: "",
    };
  }

  /**
   * 本 scope 已知的 expert child id（最近 child + 任务绑定指向的 child +
   * 本父代理该角色尚未结算的活动任务指向的 child）。
   *
   * 覆盖面刻意完整：显式 childId 的归属校验会拒绝任何不在此集合中的 id，
   * 因此这里必须包含所有**本 root 该角色**真实创建过的 child，同时绝不包含
   * 其他父代理、fan-out 或不属于该角色的 child。
   * @param {string} scope - delegationScopeKey(parentId, role)。
   * @param {string} [candidateTaskKey] - 可选的归一化任务 key（其绑定 child 也算已知）。
   * @param {{parent?:object}} [owner] - 可选的 exact root Agent：给出时额外要求 recovery
   *   record 的 parentAgent 与它一致（同 id 的另一代 root 不得接管该 record）。
   * @returns {Array<string>} 去重后的 child id 列表。
   */
  function trackerChildIdsForScope(scope, candidateTaskKey, owner) {
    const ids = new Set(delegationTracker.listChildIds(scope));
    const bound = delegationTracker.getChild(scope);
    if (bound !== void 0) ids.add(bound.childId);
    if (typeof candidateTaskKey === "string" && candidateTaskKey.length > 0) {
      const taskChild = delegationTracker.getTaskChild(scope, candidateTaskKey);
      if (taskChild !== void 0) ids.add(taskChild.childId);
    }
    // 活动任务指向的 child：任务绑定可能已被上限淘汰/结算，但 child 仍属于本 scope。
    const separator = String(scope ?? "").lastIndexOf("::");
    const parentId = separator === -1 ? void 0 : String(scope).slice(0, separator);
    if (parentId === void 0) return [...ids];
    for (const task of delegationTracker.listActiveTasks(parentId)) {
      if (task.role !== role) continue;
      if (typeof task.childId === "string" && task.childId.length > 0) ids.add(task.childId);
    }
    // 仍存活的 recovery record 持有的 expert child：task 记忆被 LRU 淘汰、route 切换
    // 清表、记录重建或活动范围已结算后，receipt 里的 childId 仍必须能被显式续作/取消
    // 定位；否则 root 只能改派新任务，而旧 child 还在跑（变成无人收口的孤儿任务）。
    // route 刻意不作为识别过滤条件：record.routeKey 是「创建时那条 route」，切换 route
    // 之后 receipt 句柄必须继续有效；route 的校验留在投递与恢复路径（续作使用当前
    // route、恢复按 routeChanged 判定重建），识别阶段只认 root+role 归属与有效性。
    const parentAgent = owner?.parent;
    for (const [recordChildId, record] of recordEntries()) {
      if (record === null || typeof record !== "object") continue;
      // 归属：只认本 parent+role 的 record；同 id 的另一代 root generation 不得接管。
      if (record.parentId !== parentId || record.role !== role) continue;
      if (parentAgent !== void 0 && record.parentAgent !== void 0 && record.parentAgent !== parentAgent) continue;
      // 有效性：只有可续接、且确实成功 acceptance 过的专家 child 才是合法目标。
      if (record.continuable !== true || record.invalidAcceptance === true) continue;
      // fan-out child 属于另一条恢复链：普通 role 工具绝不显式续作/取消它。
      if (isFanoutChildId(recordChildId)) continue;
      ids.add(recordChildId);
    }
    return [...ids];
  }

  /**
   * childId 是否属于 fan-out 链路：内存 Agent 与持久化 child_models 快照任一侧命中
   * 即算（与 agent/created 的 fan-out 判定同源），fan-out 目标永不由普通 role 工具续作。
   */
  function isFanoutChildId(childId) {
    return isFanoutAgent(agents.get(childId)) || isFanoutIdentity(storage.readSnapshot().childModels?.[childId]);
  }

  /**
   * 读取显式句柄参数（childId / cancelChildId）。
   *
   * 约定：字段**完全缺省**（undefined）才算「没有提供」；只要字段存在，就必须是
   * 非空且非纯空白的字符串。空串、纯空白与非字符串一律 fail-closed，绝不被当作
   * 「未提供」而继续普通派发/新建 child —— 那会让 root 以为在续作或取消，实际却
   * 启动了新任务（线上最危险的静默分叉）。
   *
   * 非字符串输入通常已被 DSH 工具入参校验（defineTool → INVALID_ARGS）拦在 handler
   * 之外；这里保留同一判定作为 handler 边界的第二道防线。合法的非空白字符串**不做
   * trim**：childId 是 opaque id，精确匹配失败会走 CHILD_NOT_FOUND 的可读拒绝，
   * 不扩大匹配面。
   * @returns {{present:boolean, value:string|undefined, invalid:boolean}}
   */
  function readExplicitHandle(args, name) {
    const raw = args === null || typeof args !== "object" ? void 0 : args[name];
    if (raw === void 0) return { present: false, value: void 0, invalid: false };
    if (typeof raw !== "string" || raw.trim().length === 0) return { present: true, value: void 0, invalid: true };
    return { present: true, value: raw, invalid: false };
  }

  /** 非法句柄的简短类型描述：只报类型/形态，绝不复述可能很长的原始内容。 */
  function describeHandleValue(value) {
    if (value === null) return "null";
    if (typeof value === "string") return value.length === 0 ? "空字符串" : "仅含空白的字符串";
    return typeof value;
  }

  /**
   * 构造「显式句柄在 admission 之前被拒绝」的公开结果。
   *
   * 该结果**不携带** admissionEpoch/admissionToken：被拒绝的句柄没有登记新 admission、
   * 没有创建或投递任何 child，凭据会伪造出「真实 child admission」的假象并让模型把它
   * 拿去 finalize。因此使用独立 kind `rejected`（输出 schema 中的无凭据变体），与带凭据
   * 的 advisory/continuable 明确区分；同时保持 fail-closed：绝不 interrupt、绝不派发。
   */
  function rejectedHandleResult(reason, code, warning) {
    return { kind: "rejected", started: false, accepted: false, reason, code, warning };
  }

  /**
   * 显式取消（role tool 的 cancelChildId）：按 childId 精确定位，只请求该 child
   * 的取消，不派发新任务、不投递消息。
   *
   * 严格边界：不接受「按 parent+role 猜目标」，因此同 scope 的其他独立 child
   * 不会被误取消。使用公开 subagents.interrupt(childId, { kind: "ancestor", agent })。
   */
  async function cancelExplicitChild({ childId, parent, scope }) {
    const resolved = resolveContinueTarget({ childId, parent, scope, taskKey: "" });
    if (resolved.target === void 0) return { ok: false, warning: resolved.warning };
    if (typeof subagents?.interrupt !== "function") {
      return { ok: false, warning: role + " 取消失败：当前 Host 未提供公开 subagents.interrupt" };
    }
    await subagents.interrupt(childId, { kind: "ancestor", agent: parent });
    return { ok: true, childId };
  }

    return {
      resolveContinueTarget,
      trackerChildIdsForScope,
      isFanoutChildId,
      readExplicitHandle,
      describeHandleValue,
      rejectedHandleResult,
      cancelExplicitChild,
    };
  }

  return { forRole };
}

/**
 * 显式续作触发的 child 重建（与自动恢复共用同一重建路径）。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @returns {object} `forRole(role)` 能力。
 */
export function createRoleToolRebuild({ records, core, identity, delegation, recovery, recoveryFlow, usage, storage }) {
  const { getRecord, ensureRecoveryRecord, dropRecoveryRecord } = records;
  const { resolvePersistedSubagentTarget, contextInheritanceError, markStructuredRequest, startExpertActivation } = core;
  const delegationTracker = delegation;

  function forRole(role) {
  /**
   * 显式续作触发的 child 重建：把原 child 的任务绑定迁移到替代 child。
   * 只接受仍可验证的 exact record（parent/role/owner 一致），其他情况 fail-closed
   * 上抛，绝不静默新建一个与旧任务无关的 child。
   */
  async function rebuildExistingChildForContinuation({ record, childId, parent, signal, scope, routeKey, request, label, taskKey, rootToken }) {
    if (record === void 0 || record.parentId !== parent.id || record.role !== role) {
      throw new Error(role + " 续作失败：child " + childId + " 已不可恢复且缺少可验证的恢复记录");
    }
    const durableSession = record.agent?.session ?? record.session;
    if (durableSession === void 0) {
      // 既没有 durable Session 也没有 live Activation 时，Host 无法冷恢复同一任务链，
      // 重建出的 child 只会拿到「本轮 follow-up 文本」而丢掉原任务上下文；此时明确
      // 失败并请 root 改派新任务，绝不静默把旧任务替换成一个内容不完整的 child。
      throw new Error(role + " 续作失败：child " + childId + " 已不可恢复且缺少 durable Session，请作为新任务重新派发");
    }
    // 显式续作触发的重建同样只读原 child_models 的通道快照（票据 29）：原继承型
    // child 必须继续用继承 provider，绝不因为当前设置变化而静默换成 spawn。
    const persistedChild = storage.readSnapshot()?.childModels?.[childId];
    // 持久化记录缺失（写入失败/极旧 child）时回落到本次请求已解析的目标通道，
    // 而不是无条件 spawn：后者会把“当前仍要求继承”的重建静默降级成 fresh。
    const targetSnapshot = persistedChild ?? {
      subagentProvider: request.subagentProvider,
      inheritContext: request.agentOptions?.[EXPERT_INHERIT_CONTEXT_MARKER],
    };
    let rebuildTarget;
    try {
      rebuildTarget = resolvePersistedSubagentTarget(role, parent, targetSnapshot);
    } catch (error) {
      throw contextInheritanceError(
        role + " 续作失败：" + (error instanceof Error ? error.message : String(error))
          + "；请作为新任务重新派发",
        error?.code === CONTEXT_INHERITANCE_ERROR_CODES.EMPTY
          ? CONTEXT_INHERITANCE_ERROR_CODES.EMPTY
          : CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
      );
    }
    request.subagentProvider = rebuildTarget.provider;
    if (request.agentOptions !== void 0 && typeof request.agentOptions === "object") {
      request.agentOptions[EXPERT_SUBAGENT_PROVIDER_MARKER] = rebuildTarget.provider;
      request.agentOptions[EXPERT_INHERIT_CONTEXT_MARKER] = rebuildTarget.inheritContext;
    }
    // 结构化交付（票据 30）：续作触发的重建同样是新 activation；只有本轮显式
    // 重新给出 schema 时才能声明，否则历史声明只能标记 schema_not_restored。
    if (request.outputSchema === undefined && persistedChild?.outputSchemaRequested === true) {
      if (request.agentOptions !== void 0 && typeof request.agentOptions === "object") {
        request.agentOptions[OUTPUT_SCHEMA_REQUESTED_MARKER] = true;
      }
      markStructuredRequest(request, { requested: true, notRestored: true });
    }
    let rebuiltChildId;
    let messageId;
    try {
      ({ childId: rebuiltChildId, messageId } = await startExpertActivation({
        request,
        label,
        signal,
      }));
    } catch (error) {
      const capacityError = createSubagentCapacityError(error);
      if (capacityError !== undefined) throw capacityError;
      throw error;
    }
    if (!identity.isLiveGeneration(parent, rootToken)) {
      const lateRecord = getRecord(rebuiltChildId);
      if (lateRecord?.parentAgent === parent) dropRecoveryRecord(rebuiltChildId, "root generation retired", lateRecord, { releaseScope: false });
      throw new Error("root generation is no longer live");
    }
    if (typeof rebuiltChildId !== "string" || rebuiltChildId.length === 0
      || typeof messageId !== "string" || messageId.length === 0) {
      throw new Error("startContinuable returned an invalid acceptance");
    }
    // 旧 child 的未接受 recovery 由此被替代；旧 Agent 的迟到事件按 id 自然忽略。
    recoveryFlow.supersedePendingRecoveryOps(record);
    const replacement = ensureRecoveryRecord(rebuiltChildId, parent.id, role, parent, void 0, true);
    delegationTracker.setChild(scope, { childId: rebuiltChildId, routeKey });
    delegationTracker.rememberTask(scope, taskKey, { childId: rebuiltChildId, routeKey });
    delegationTracker.rebindActiveTasks({
      parentId: parent.id,
      role,
      oldChildId: childId,
      newChildId: rebuiltChildId,
      messageId,
      taskKeys: [taskKey],
    });
    replacement.tasks.set(taskKey, { messageId, childId: rebuiltChildId });
    evictOldestEntries(replacement.tasks, TASK_BINDING_LIMIT);
    delete replacement.invalidAcceptance;
    recovery.rememberContext(replacement, { routeKey, request, label, taskKey });
    usage.persistChildDispatch(rebuiltChildId, replacement, request, label, messageId);
    return { kind: "continuable", subagentId: rebuiltChildId, messageId };
  }

    return { rebuildExistingChildForContinuation };
  }

  return { forRole };
}

/**
 * 复用或向既有 child 投递（`reuseOrSteer`）：reused / queued / NOT_RESUMABLE(null)。
 *
 * @param {object} deps - 窄能力面（6 组）。
 * @returns {object} `forRole(role)` 能力。
 */
export function createRoleToolSteer({ delegation, records, handoff, recoveryFlow, identity, childIo }) {
  const delegationTracker = delegation;
  const { getRecord, ensureRecoveryRecord, dropRecoveryRecord } = records;
  const { registerPendingHandoffAdmission, failPendingHandoffAdmission, settlePendingChildTurnEnds, removePendingHandoffAdmission } = handoff;

  function forRole(role) {
  /**
   * 复用或投递到既有 child；判定为需要新建时返回 null。
   * 复用（reused）时不发送任何新 prompt；续作（queued）时返回同一 childId。
   *
   * 调用边界（多 child 语义）：本函数只处理**已经确定目标 child** 的两种情形——
   * 归一化后完全相同的任务复用其原 child，或 root 显式给出 childId 的续作
   * （explicit=true）。不同 prompt 的普通派发不再走到这里，而是新建独立 child，
   * 因此本函数不会因为没有 childId 就把新任务静默当成旧任务的续作。
   * NOT_RESUMABLE 走新建分支；容量耗尽抛可读提示（不重建：撞上限时重建必然
   * 再失败），其他错误（UNAUTHORIZED/DRAINING 等）必须原样上抛，不能吞掉。
   * B3/S1-D：投递成功后写任务绑定 record.tasks（taskKey -> { messageId,
   * childId }）；reused 分支返回原绑定（含 messageId），供任务终态关联原 turn
   * 的最终结果或命中成功缓存。binding 在 admission **之前**以
   * pendingMessage:true 预登记（消息 id 未知），admission 返回后回填
   * messageId 并清标记——claimed 补绑可覆盖回调晚于认领事件的竞态。
   */
  async function reuseOrSteer({ scope, childId, taskKey, promptText, promptContent, parent, signal, activityId, queue = false, handoffExpected = false, rootToken, explicit = false, continuationRouteKey }) {
     if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    if (delegationTracker.hasTask(scope, taskKey)) {
      // 归一化后完全相同的任务已记录：默认不发送新 prompt，直接复用同一 child。
      if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      const record = getRecord(childId);
      if (record?.invalidAcceptance === true) return null;
      const binding = record?.tasks?.get(taskKey);
      // 显式续作（root 给出 childId）必须真的把本轮 prompt 投递给**那个** child：
      // 该 child 上没有本任务绑定、或绑定指向别的 child 时都不能静默「复用」——
      // 否则回执的 subagentId/messageId 与请求矛盾，root 以为已投递却发给了别的 child。
      // 只有「绑定正好就是这个 child」才复用；不带 childId 的普通重复派发保持旧语义
      // （复用其绑定 child；没有绑定时返回无 messageId 的 reused）。
      const boundHere = binding !== void 0 && binding.childId === childId;
      if (explicit !== true || boundHere) {
        if (binding !== void 0) {
          return { kind: "continuable", subagentId: binding.childId, reused: true, messageId: binding.messageId };
        }
        // 没有任务绑定（旧版记录/记录已被上限淘汰）：保持旧行为，无 messageId。
        return { kind: "continuable", subagentId: childId, reused: true };
      }
    }

    if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    const record = ensureRecoveryRecord(childId, parent.id, role, parent, void 0, true);
    const pendingAdmission = handoffExpected === true
      ? registerPendingHandoffAdmission(parent, role, childId, taskKey)
      : void 0;
    // 已通过父会话级范围预检的任务在 steer 前绑定到已知 child；若后续
    // NOT_RESUMABLE 而重建，new-child 路径会改写该绑定。
    if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId);
    // S1-D：admission 前先登记 pendingMessage 绑定（messageId 尚不确定），
    // claimed 补绑可据此按任务文本匹配回填。
    record.tasks.set(taskKey, { messageId: null, childId, pendingMessage: true });
    evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
    let messageId;
    // acceptance 事实与 lineage 复查解耦（票据 07）：sendMessage 返回 messageId 即
    // 该 child 已经开始了一轮真实 turn，此后即使 root 代际退休也不是停止证据，
    // 不能把这次预登记当成 "未创建 child" 释放。
    let acceptedMessageId;
    try {
      // 同 route 的既有 child：queue=true 也由公开 manager sendMessage 投递；
      // queue=false 才先请求 interrupt。RC1 sendMessage 对 live/cold 统一负责 admission。
      messageId = await childIo.sendMessageToExistingChild({
        parent,
        childId,
        content: Array.isArray(promptContent) ? promptContent : [{ type: "text", text: promptText }],
        signal,
        rootToken,
        // 只有「显式续作且未要求排队」才允许先请求公开 interrupt（用户显式要求
        // 暂停/重定向）。普通新任务永远不会走到这里；即使走到也不得取消既有 child。
        interrupt: explicit === true && queue !== true,
        queue: queue === true,
      });
      if (typeof messageId === "string" && messageId.length > 0) acceptedMessageId = messageId;
      if (typeof messageId !== "string" || messageId.length === 0) throw new Error("existing child admission returned an invalid messageId");
      if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      if (pendingAdmission !== void 0) {
        pendingAdmission.activation = record.agent;
        pendingAdmission.messageId = messageId;
      }
    } catch (error) {
      if (!identity.isLiveGeneration(parent, rootToken)) {
        if (pendingAdmission !== void 0) {
          failPendingHandoffAdmission(parent, pendingAdmission, record);
          settlePendingChildTurnEnds(parent, false, pendingAdmission);
          removePendingHandoffAdmission(pendingAdmission);
        }
        // 只有确实没有产生 child turn（admission 在 acceptance 之前失败）才撤销
        // 本次预登记；已接受的消息保留保护（detached），等待 child turn/end/disposal。
        if (activityId !== void 0 && acceptedMessageId === void 0) delegationTracker.releaseActiveTask(activityId);
        const lateRecord = getRecord(childId);
        if (lateRecord?.parentAgent === parent) dropRecoveryRecord(childId, "root generation retired", lateRecord, { releaseScope: false });
        throw error;
      }
      // existing-child admission 失败只消费同一 token 暂存的 turn/end，不得 drain 其他 admission。
      if (pendingAdmission !== void 0) {
        failPendingHandoffAdmission(parent, pendingAdmission, record);
        settlePendingChildTurnEnds(parent, false, pendingAdmission);
      }
      removePendingHandoffAdmission(pendingAdmission);
      // 只有 helper admission 失败才清理 pending binding；此处尚无新任务
      // acceptance，因此绝不能提前 supersede 旧 recovery。若 claimed 已先观察到消息，则保留那条已接受消息的绑定，避免把真实任务误删。
      const binding = record.tasks.get(taskKey);
      if (binding !== void 0 && binding.pendingMessage === true && binding.messageId === null) {
        record.tasks.delete(taskKey);
      }
      // 容量耗尽（等待子代理完成，或继续使用现有子代理）不是「child 已损坏」：
      // 重建只会立刻再次撞上限，因此这里不落 NOT_RESUMABLE 的新建分支。抛出的是
      // 携带 DEG 自有稳定 code 的可读错误（不含宿主原始码/英文文案），上层分类表
      // 据此归入可重试的 steer 失败，而不是伪装成成功或原样透传宿主错误。
      const capacityError = createSubagentCapacityError(error);
      if (capacityError !== undefined) throw capacityError;
      if (error?.code !== "NOT_RESUMABLE") throw error;
      return null;
    }

    // messageId 已返回即新任务 admission 边界：此后才允许取代旧 recovery。
    // 先 supersede 再重写当前 binding，避免旧 op 恰好拥有相同 taskKey 时把
    // 刚接受的新消息标成 superseded；accepted recovery op 会被 helper 跳过。
    // 取代与任务记忆都只针对本次续作的目标 child：其他独立 child 的 recovery
    // 和任务绑定不受影响（多 child 语义）。
    recoveryFlow.supersedePendingRecoveryOps(record);
    delegationTracker.rememberTask(scope, taskKey, { childId, routeKey: continuationRouteKey });
    record.tasks.set(taskKey, { messageId, childId });
    evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
    if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId, messageId);
    return { kind: "continuable", subagentId: childId, queued: true, messageId, handoffAdmission: pendingAdmission };
  }

    return { reuseOrSteer };
  }

  return { forRole };
}

/**
 * 显式续作：先复用/投递，NOT_RESUMABLE 时走重建（不回落新建）。
 *
 * @param {object} deps - 窄能力面（3 组）。
 * @returns {object} `forRole(role, { steer, rebuild })` 能力。
 */
export function createRoleToolContinue({ records, recovery, identity }) {
  const { getRecord, dropRecoveryRecord } = records;

  function forRole(role, { steer, rebuild }) {
    const { reuseOrSteer } = steer;
    const { rebuildExistingChildForContinuation } = rebuild;
  /**
   * 显式续作：向指定 child 投递本轮 prompt。
   *
   * 走既有公开 continuation seam（reuseOrSteer → subagents.sendMessage/interrupt）：
   * lineage/root generation 校验、message admission 与 disposal 都由 Host 负责。
   * 语义保留既有边界：
   * - queue=true 只排队（公开 sendMessage 投递，不请求 cancel）；
   * - queue=false 允许先请求公开 interrupt（用户显式要求暂停/重定向才由 root 显式续作）；
   * - 投递失败不得回落到新建 child，只有 NOT_RESUMABLE 才由既有重建路径处理。
   * @returns {Promise<object>} admission 结果（continuable/reused）。
   */
  async function continueExplicitChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken, target }) {
    if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    let outcome;
    try {
      outcome = await reuseOrSteer({
        scope,
        childId: target.childId,
        taskKey,
        promptText: request.prompt[0].text,
        promptContent: request.prompt,
        parent,
        signal,
        queue,
        handoffExpected,
        rootToken,
        explicit: true,
        continuationRouteKey: routeKey,
      });
    } catch (error) {
      // 容量耗尽必须在这里就带上 DEG 自有稳定 code：后续的 lineage 检查会抛普通
      // 错误，那会覆盖分类信息，让上层把「容量」误判成泛化 admission 失败。
      const capacityError = createSubagentCapacityError(error);
      if (capacityError !== undefined) throw capacityError;
      throw error;
    }
    if (!identity.isLiveGeneration(parent, rootToken)) {
      const lateRecord = getRecord(target.childId);
      // root 代际退休不释放保护：只丢弃无法再关联的 record。
      if (lateRecord?.parentAgent === parent) dropRecoveryRecord(target.childId, "root generation retired", lateRecord, { releaseScope: false });
      throw new Error("root generation is no longer live");
    }
    if (outcome !== null) {
      recovery.rememberContext(getRecord(outcome.subagentId), { routeKey, request, label, taskKey });
      return outcome;
    }
    // 显式续作遇到 NOT_RESUMABLE：按既有恢复语义重建一个 continuable child，
    // 原 child 的 pending recovery 由此接管（与自动恢复的 rebuild 同一路径）。
    return rebuildExistingChildForContinuation({
      record: target.record,
      childId: target.childId,
      parent,
      signal,
      scope,
      routeKey,
      request,
      label,
      taskKey,
      rootToken,
    });
  }

    return { continueExplicitChild };
  }

  return { forRole };
}

/**
 * 新建独立 child 事务（pending creation 预登记、acceptance 回填、失败回滚）。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @returns {object} `forRole(role)` 能力。
 */
export function createRoleToolNewChild({ delegation, records, handoff, recovery, recoveryFlow, core, usage, identity }) {
  const delegationTracker = delegation;
  const { getRecord, ensureRecoveryRecord, dropRecoveryRecord, pushPendingCreation, removePendingCreation, rollbackCreationTransaction } = records;
  const { registerPendingHandoffAdmission, bindPendingHandoffAdmission, failPendingHandoffAdmission, removePendingHandoffAdmission } = handoff;
  const { startExpertActivation } = core;
  const { getAgent } = identity;

  function forRole(role) {
    // 新建 child（route 已变 / 快照恢复失败 / NOT_RESUMABLE 重试）。
    // P3：在 startContinuable **之前**预登记 pendingCreations——agent/created
    // 在创建过程中同步触发（早于 promise resolve），inbox claimed 可能在此
    // 之前按任务文本补绑 binding；预登记让 agent/created 立即写入
    // pendingMessage 绑定，消除「消息已认领但 record.tasks 尚无绑定」的
    // acceptance 竞态。父+角色在 scope 临界区内串行，同 scope 最多一项。
    async function createNewChild({ scope, taskKey, routeKey, request, parent, signal, label, activityId, handoffExpected, rootToken, explicitContinue, retiredChildId, retiredRecord }) {
  const pendingHandoffAdmission = handoffExpected === true
      ? registerPendingHandoffAdmission(parent, role, void 0, taskKey)
      : void 0;
    const creationTransaction = {
      parent, rootToken, taskKey, activityId, handoffAdmission: pendingHandoffAdmission,
      childId: void 0, agent: void 0, record: void 0, recordOwned: false, taskBindingOwned: false,
    };
    const pendingCreation = { parent, rootToken, taskKey, parentId: parent.id, role, activityId, handoffExpected, handoffAdmission: pendingHandoffAdmission, transaction: creationTransaction };
    pushPendingCreation(pendingCreation);
    let acceptedChildId;
    try {
      let childId;
      let messageId;
      try {
        ({ childId, messageId } = await startExpertActivation({
          request,
          label,
          signal,
        }));
      } catch (error) {
        // 容量耗尽在 admission 边界就翻译成 DEG 自有可读错误：后续清理/回滚错误
        // 一旦覆盖原始 code，上层就无法再归入「可重试的容量」而是泛化失败。
        const capacityError = createSubagentCapacityError(error);
        if (capacityError !== undefined) throw capacityError;
        throw error;
      }
      acceptedChildId = childId;
      if (typeof childId !== "string" || childId.length === 0 || typeof messageId !== "string" || messageId.length === 0) throw new Error("startContinuable returned an invalid acceptance");
      if (!identity.isLiveGeneration(parent, rootToken)) {
        if (pendingHandoffAdmission !== void 0) {
          failPendingHandoffAdmission(parent, pendingHandoffAdmission, getRecord(childId));
          removePendingHandoffAdmission(pendingHandoffAdmission);
        }
        const lateRecord = getRecord(childId);
        if (lateRecord?.parentAgent === parent) dropRecoveryRecord(childId, "root generation retired", lateRecord, { releaseScope: false });
        throw new Error("root generation is no longer live");
      }
      if (pendingHandoffAdmission !== void 0) bindPendingHandoffAdmission(pendingHandoffAdmission, childId, messageId);
      // 多 child 边界：不同任务的独立 child 并存，因此**只有显式指定/复用同一
      // child 的路径**才取代该 child 未 acceptance 的 recovery。新建独立 child
      // 绝不 supersede 其他 child 的 recovery（否则会打断那个 child 的自愈链）。
      // 复用/续作路径由 reuseOrSteer / continueExplicitChild 自己完成取代。
      if (explicitContinue === true && retiredChildId !== void 0 && retiredChildId !== childId) {
        recoveryFlow.supersedePendingRecoveryOps(retiredRecord ?? getRecord(retiredChildId));
      }
      delegationTracker.setChild(scope, { childId, routeKey });
      if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId, messageId);
      // 任务记忆必须带上它自己的 child：相同 prompt 之后复用的是这个 child，
      // 而不是本 scope 最近一次新建的 child。
      delegationTracker.rememberTask(scope, taskKey, { childId, routeKey });
      // P3 防御：agent/created 应已消费预登记项；异常路径（未命中）时清理
      // 残留，防止下次同 scope 新建误匹配旧 taskKey。
      removePendingCreation(pendingCreation);
      // 确保恢复记录存在（事件处理据此关联 turn；重启后冷恢复的 child 也在此登记）。
      // startContinuable 返回时消息 id 已确定：回填 agent/created 预登记的
      // pendingMessage 绑定（claimed 补绑可能已先行回填）；找不到绑定（预登记
      // 未命中/已被上限淘汰）则直接写完整绑定，保持幂等。
      // S2：route 切换**不**删除旧 child 的 record——records 随父代理销毁/插件
      // 卸载清理，数量以 child 计，可接受（惰性清理函数已移除）。
      const existingRecord = getRecord(childId);
      const record = ensureRecoveryRecord(childId, parent.id, role, parent, void 0, true);
      creationTransaction.childId = childId;
      if (creationTransaction.record === void 0) {
        // agent/created 可能已同步消费 pendingCreation；此时必须保留它
        // 已记录的 recordOwned=true，不能因本阶段再次 get 到同一 record
        // 就把新建事务误判为 durable 旧 record。
        creationTransaction.record = record;
        creationTransaction.recordOwned = existingRecord === void 0;
      }
      creationTransaction.agent = record.agent;
      registerPluginExpertChildAgent(getAgent(childId) ?? creationTransaction.agent);
      const binding = record.tasks.get(taskKey);
      if (binding !== void 0 && binding.pendingMessage === true && binding.messageId === null) {
        if (creationTransaction.binding === void 0) {
          creationTransaction.binding = binding;
          creationTransaction.taskBindingOwned = false;
        }
        binding.messageId = messageId;
        binding.pendingMessage = false;
      } else {
        const previousBinding = binding;
        const nextBinding = { messageId, childId };
        record.tasks.set(taskKey, nextBinding);
        creationTransaction.previousBinding = previousBinding;
        creationTransaction.binding = nextBinding;
        // fallback binding 同样是本 acceptance 写入；有旧值时由 helper 恢复，
        // 无旧值时由 helper 删除。
        creationTransaction.taskBindingOwned = true;
        evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
      }
      delete record.invalidAcceptance;
      recovery.rememberContext(record, { routeKey, request, label, taskKey });
      usage.persistChildDispatch(childId, record, request, label, messageId);
      return { kind: "continuable", subagentId: childId, messageId, handoffAdmission: pendingHandoffAdmission };
    } catch (error) {
      // 事务所有权覆盖 agent/created 已同步消费 pendingCreation 的情况；
      // 先解绑 exact admission/activity/task，再处理 root 代际的迟到 child。
      rollbackCreationTransaction(creationTransaction, "startContinuable acceptance failed");
      if (!identity.isLiveGeneration(parent, rootToken) && acceptedChildId !== void 0) {
        const lateRecord = getRecord(acceptedChildId);
        if (lateRecord?.parentAgent === parent) dropRecoveryRecord(acceptedChildId, "root generation retired", lateRecord, { releaseScope: false });
      }
      // startContinuable 抛错：删除对应 pending 项（agent/created 未消费时
      // 清理残留，防泄漏；被消费过则 indexOf 为 -1，无操作）。
      removePendingCreation(pendingCreation);
      throw error;
    }
  }

    return { createNewChild };
  }

  return { forRole };
}

/**
 * 冷启动快照恢复：按 parentId + role + route 找可复用 child，再走统一投递分支。
 *
 * @param {object} deps - 窄能力面（6 组）。
 * @returns {object} `forRole(role, { steer })` 能力。
 */
export function createRoleToolRestoreChild({ delegation, records, recovery, usage, core, identity }) {
  const delegationTracker = delegation;
  const { getRecord, dropRecoveryRecord } = records;
  const { restoreChildFromSnapshot } = core;

  function forRole(role, { steer }) {
    const { reuseOrSteer } = steer;

    /**
     * 重启后内存为空时尝试恢复：只恢复 child 与 route，不恢复任务记录（重启后无法
     * 确认旧任务是否已执行，相同任务也走 steer 排队，而不是静默复用）。
     *
     * @returns {Promise<{restoredChildId:string, restoredRecord:object|undefined, reused:object|null}|undefined>}
     *   未恢复时 undefined；`reused` 为 null 表示 NOT_RESUMABLE，调用方转新建。
     */
    async function restoreExistingChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, activityId, handoffExpected, rootToken }) {
      const restored = restoreChildFromSnapshot(parent.id, role, routeKey);
      if (restored === void 0) return void 0;
      const restoredRecordBefore = getRecord(restored);
      delegationTracker.setChild(scope, { childId: restored, routeKey });
      const reused = await reuseOrSteer({ scope, childId: restored, taskKey, promptText: request.prompt[0].text, promptContent: request.prompt, parent, signal, queue, activityId, handoffExpected, rootToken, continuationRouteKey: routeKey });
      if (reused !== null) {
        if (!identity.isLiveGeneration(parent, rootToken)) {
          // reused 分支没有为本任务产生新的 child turn，预登记可撤销；真正投递
          // 成功（queued/messageId）的 admission 属于已开始的 child turn，保留保护。
          if (activityId !== void 0 && reused.reused === true) delegationTracker.releaseActiveTask(activityId);
          const lateRecord = getRecord(reused.subagentId);
          if (lateRecord?.parentAgent === parent) dropRecoveryRecord(reused.subagentId, "root generation retired", lateRecord, { releaseScope: false });
          throw new Error("root generation is no longer live");
        }
        const restoredRecord = getRecord(reused.subagentId);
        recovery.rememberContext(restoredRecord, { routeKey, request, label, taskKey });
        if (reused.reused !== true) usage.persistChildDispatch(reused.subagentId, restoredRecord, request, label, reused.messageId);
      }
      return { restoredChildId: restored, restoredRecord: restoredRecordBefore, reused };
    }

    return { restoreExistingChild };
  }

  return { forRole };
}

/**
 * 后台委派判定（显式续作 / 相同任务复用 / 快照恢复 / 新建）。
 *
 * @param {object} deps - 窄能力面（3 组）。
 * @returns {object} `forRole(role, { continuation, newChild, restoreChild })` 能力。
 */
export function createRoleToolDelegatePaths({ identity, delegation, records }) {
  const delegationTracker = delegation;
  const { getRecord } = records;

  function forRole(role, { continuation, newChild, restoreChild }) {
    /**
     * scope 临界区内执行后台委派（唯一入口，保证同父同角色串行）：
     * 判定顺序（多 child 语义）：
     * 0. root 显式给出 childId → 只向该 child 续作（找不到目标由上层 advisory 拒绝）；
     * 1. 任务 key 已绑定到本 scope 的某个 child（归一化后完全相同的任务）→ 复用它，
     *    不新建、不投递；绑定的不是最近 child 时同样按绑定续作；
     *    ⚠ 没有该任务绑定时**不再**投向「最近一个 child」——不同 prompt 必须新建独立
     *    child，绝不隐式 steer；
     * 2. 内存无 child：尝试从持久化 childModels 恢复同 parentId+role+route 的
     *    continuable child（重启恢复；旧记录无标记时忽略），恢复后走统一投递分支；
     * 3. 其余情况（不同 prompt / route 已变 / 恢复失败 / NOT_RESUMABLE）→ 新建独立
     *    child，并记录「本任务 key -> 新 child」绑定；新建不再清空同 route 其他 child
     *    的任务记忆，也不再取代它们的 recovery。
     */
    async function delegateBackground({ scope, taskKey, routeKey, request, parent, signal, label, queue = false, activityId, handoffExpected = false, rootToken, explicitChildId, continuationChildId }) {
      if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      // 只有「指向既有 child 的路径」才允许取代该 child 未接受的 recovery；
      // 新建独立 child 必须保留其他 child 的自愈链（多 child 语义）。
      const explicitContinue = explicitChildId !== void 0 || continuationChildId !== void 0;
      const current = delegationTracker.getChild(scope);
      // 记录可能被替换的旧 child；只有新 child 的 startContinuable 返回
      // accepted messageId 后，才会对其未接受 recovery 做 supersede。
      // 显式续作/相同任务复用不新建 child，因此不会取代任何其他 child 的 recovery。
      let retiredChildId = explicitChildId ?? continuationChildId ?? current?.childId;
      let retiredRecord = retiredChildId === void 0 ? void 0 : getRecord(retiredChildId);
      if (explicitChildId !== void 0) {
        // root 显式指定 childId：续作只发给该 child，绝不落到新建分支。
        const continued = await continuation.continueExplicitChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken, target: { childId: explicitChildId, record: retiredRecord, routeKey } });
        if (continued !== null) return continued;
      } else if (continuationChildId !== void 0) {
        // 相同 prompt 复用它自己的 child（可能是同 scope 下更早的独立 child，也可能
        // 就是最近一个 child）：两种情况都必须先解析出那个 child，绝不新建。
        const boundRecord = getRecord(continuationChildId);
        const boundRouteKey = delegationTracker.getTaskChild(scope, taskKey)?.routeKey ?? routeKey;
        const reusedEarlier = await continuation.continueExplicitChild({ scope, taskKey, routeKey: boundRouteKey, request, parent, signal, label, queue, handoffExpected, rootToken, target: { childId: continuationChildId, record: boundRecord, routeKey: boundRouteKey } });
        if (reusedEarlier !== null) return reusedEarlier;
      } else if (current === void 0) {
        const restored = await restoreChild.restoreExistingChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, activityId, handoffExpected, rootToken });
        if (restored !== void 0) {
          retiredChildId = restored.restoredChildId;
          retiredRecord = restored.restoredRecord;
          if (restored.reused !== null) return restored.reused;
        }
      }
      return newChild.createNewChild({ scope, taskKey, routeKey, request, parent, signal, label, activityId, handoffExpected, rootToken, explicitContinue, retiredChildId, retiredRecord });
    }

    return { delegateBackground };
  }

  return { forRole };
}

/**
 * scope 临界区预检与活动登记（`delegateWithScopeAdmission`）。
 *
 * @param {object} deps - 窄能力面（4 组）。
 * @returns {object} `forRole(role, { handles, delegatePaths })` 能力。
 */
export function createRoleToolScopeAdmission({ identity, delegation, records, handoff }) {
  const delegationTracker = delegation;
  const { getRecord, dropRecoveryRecord } = records;
  const { removePendingHandoffAdmission } = handoff;

  function forRole(role, { handles, delegatePaths }) {
    const { trackerChildIdsForScope } = handles;
  /**
   * 在同父代理的短临界区内完成范围预检和活动登记，再释放该锁执行实际
   * start/sendMessage。这样不同角色的独立任务仍并行，但相交范围无法
   * 同时穿过空登记表。同一任务（或显式 childId 续作）沿用既有复用/续作语义，
   * 不再登记第二个活动项；**不同任务**则各自登记独立活动项并新建独立 child，
   * 因此多个独立 child 的范围冲突仍由 affectedPaths 预检覆盖。
   * admission 失败会立即释放本次预登记。
   */
  async function delegateWithScopeAdmission({ scope, taskKey, routeKey, request, parent, signal, label, queue = false, affectedPaths, allowOverlap = false, handoffExpected = false, rootToken, explicitChildId }) {
    if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    const current = delegationTracker.getChild(scope);
    // 显式 childId 在上层已经校验过归属，因此它天然是「已存在目标」；其余情况
    // 只有「同一归一化任务仍绑定到本 scope 的 child」才算重复任务。绑定指向的
    // child 已从本 scope 退出（重建/清理过）时按新任务处理，避免对消失的 child
    // 反复返回无法续作的 advisory。
    const bound = delegationTracker.getTaskChild(scope, taskKey);
    const boundIsLive = bound !== void 0 && trackerChildIdsForScope(scope, taskKey, { parent }).includes(bound.childId);
    const knownDuplicate = explicitChildId !== void 0
      || (boundIsLive && bound.routeKey === routeKey);
    if (knownDuplicate) {
      return delegatePaths.delegateBackground({
        scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken,
        explicitChildId,
        // 相同任务一律按「它自己绑定的 child」续作（可能就是最近 child）。
        continuationChildId: explicitChildId === void 0 && boundIsLive ? bound.childId : void 0,
      });
    }
    const admission = await delegationTracker.serializeParent(parent.id, () => {
      if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      const check = delegationTracker.checkActiveTaskScope({ parentId: parent.id, affectedPaths, allowOverlap });
      if (check.blocked === true) return { kind: "advisory", started: false, accepted: false, reason: "scope-conflict", code: "SCOPE_CONFLICT", warning: check.warning };
      const activity = delegationTracker.registerActiveTask({
        parentId: parent.id,
        parentAgent: parent,
        role,
        taskKey,
        description: label,
        affectedPaths,
      });
      return {
        activityId: activity.id,
        ...(typeof check.warning === "string" && check.warning.length > 0 ? { scopeWarning: check.warning } : {}),
      };
    });
    if (admission.kind === "advisory") return admission;
    if (!identity.isLiveGeneration(parent, rootToken)) {
      delegationTracker.releaseActiveTask(admission.activityId);
      throw new Error("root generation is no longer live");
    }
    // admission 是否已经产生 child turn：只有「未创建/未接受」的失败才能撤销预登记
    // （票据 07：root 结束、代际更新都不是停止证据，不得释放已接受任务的范围保护）。
    let accepted = false;
    try {
      const outcome = await delegatePaths.delegateBackground({
        scope, taskKey, routeKey, request, parent, signal, label, queue, activityId: admission.activityId, handoffExpected, rootToken, explicitChildId,
      });
      accepted = true;
      if (!identity.isLiveGeneration(parent, rootToken)) {
        // 本次任务已被 child 接受：保留为 detached 保护，等待该 child 自己的
        // turn/end 或 disposal；代际退休本身绝不释放。
        const lateRecord = getRecord(outcome?.subagentId);
        if (lateRecord?.parentAgent === parent) dropRecoveryRecord(outcome.subagentId, "root generation retired", lateRecord, { releaseScope: false });
        removePendingHandoffAdmission(outcome?.handoffAdmission);
        throw new Error("root generation is no longer live");
      }
      return {
        ...outcome,
        ...(admission.scopeWarning === void 0 ? {} : { scopeWarning: admission.scopeWarning }),
      };
    } catch (error) {
      // 已接受（delegateBackground 正常返回）后的迟到异常不释放保护；仍是 admission
      // 明确失败/未创建 child 时才撤销本次预登记。
      if (accepted !== true) delegationTracker.releaseActiveTask(admission.activityId);
      throw error;
    }
  }

    return {
      delegateWithScopeAdmission,
      // 入口侧 execute/observer 仍按原样在 scope 临界区内调用 delegate（同一把锁）。
      serialize: (...args) => delegationTracker.serialize(...args),
    };
  }

  return { forRole };
}

/**
 * role 闭包组装：把上面各分组按挂载时刻装配成 `{ execute 依赖的扁平能力面 }`。
 *
 * 组装本身不持有状态，也不注册任何东西；参数是本模块自己的 8 个工厂面
 * （C3 记为 8 组，均在台账逐项登记）。
 *
 * @param {object} parts - 本模块的 8 个工厂面。
 * @returns {object} `forRole(role)` 能力。
 */
export function createRoleToolClosures(parts) {
  const { handles, rebuild, steer, continuation, newChild, restoreChild, delegatePaths, scopeAdmission } = parts;

  function forRole(role) {
    const handlesApi = handles.forRole(role);
    const rebuildApi = rebuild.forRole(role);
    const steerApi = steer.forRole(role);
    const continuationApi = continuation.forRole(role, { steer: steerApi, rebuild: rebuildApi });
    const newChildApi = newChild.forRole(role);
    const restoreApi = restoreChild.forRole(role, { steer: steerApi });
    const pathsApi = delegatePaths.forRole(role, { continuation: continuationApi, newChild: newChildApi, restoreChild: restoreApi });
    const scopeApi = scopeAdmission.forRole(role, { handles: handlesApi, delegatePaths: pathsApi });
    return { ...handlesApi, ...rebuildApi, ...steerApi, ...continueApiOf(continuationApi), ...newChildApi, ...restoreApi, ...pathsApi, ...scopeApi };
  }

  return { forRole };
}

/** 续作能力面的解包（保持返回面扁平，便于入口按名解构）。 */
function continueApiOf(continuationApi) {
  return { continueExplicitChild: continuationApi.continueExplicitChild };
}
