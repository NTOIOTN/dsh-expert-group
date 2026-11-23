/**
 * 入口 agent/created 事件接线域（R4e · 票据 19）。
 *
 * 这是 `ctx.on("agent/created")` 的**纯 handler**：判定新出现的 Agent 属于哪一类
 * （root / 普通专家 child），并把它接入对应的边界。
 *
 * 分支顺序是行为契约（与迁移前逐行一致）：
 * 1. registry 已指向另一个 Agent 的迟到旧 Activation 直接短路；
 * 2. root 出现时激活代际并退休同 id 旧代际；
 * 3. `engageRootTurnWaitForCreatedAgent`：任何 child 出现都意味着 root 可能有工作未结束；
 * 4. 剩余路径解析专家身份、登记恢复记录、写 child_models 与安装 scoped guard。
 *
 * ## 铁律（票据 19）
 * 本模块**不接收 ctx**：`ctx.on("agent/created")` 的注册仍由 `index.js` 在原注册点执行，
 * 这里只返回 `handleAgentCreated(agent)`。
 *
 * ## 状态唯一 owner
 * 本模块不持容器：根代际表、等待账本、恢复记录都各自由其域模块拥有，这里只调用它们的命令。
 *
 * @module dsh-expert-group/host/index-agent-created
 */
import { EXPERT_SUBAGENT_PROVIDER_MARKER } from "../shared/model-route.js";
import { ROLE_MARKER, PARENT_MARKER, registerPluginExpertChildAgent } from "./expert-guards.js";

/**
 * 创建 agent/created handler。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与 agent id）。
 * @param {object} deps.rootWait - root 等待域：`engageRootTurnWaitForCreatedAgent(agent)`。
 * @param {object} deps.roots - 根代际面（identity + prelude + 退休命令的同一关注点）：
 *   `agents`、`lineage`（activeRoot/activateRoot/tokenFor）、`rootGenerationRegistry`
 *   （activate/generationOf）、`notificationHost`（activateRoot）、`isRootAgentIdentity`、
 *   `retireRootGeneration`。
 * @param {object} deps.guards - 组合根的 guard 安装 adapter（F6 留 index.js）：
 *   `installExpertReportGuard(agent, identity)`。
 * @param {object} deps.effort - effort 域：`resolveEffortOf`、`installEffortInjection`。
 * @param {object} deps.records - 恢复登记域：`registerExpertRecovery`、`getRecord`、
 *   `readChildActivation`、`noteChildActivation`、`invalidateRequestRetryState`。
 * @param {object} deps.snapshot - child 快照域：`resolveExpertIdentity`、`persistChildModel`、
 *   `installFallbackRoute`。
 * @returns {{handleAgentCreated: (agent: object) => void}} handler 能力面。
 */
export function createAgentCreatedHandler({ logger, rootWait, roots, guards, effort, records, snapshot, getOrdinaryActivationIntent }) {
  /**
   * 绑定 Activation / root 代际。
   * @param {object} agent - exact Agent 对象。
   * @returns {boolean} true 表示「迟到旧 Activation」，调用方必须短路本次 created。
   */
  function isLateActivation(agent) {
    if (typeof agent?.id !== "string") return false;
    const registered = roots.agents.get(agent.id);
    if (registered !== void 0 && registered !== agent) {
      // root replacement 必须由宿主 registry 的 exact Agent 背书，不能凭迟到事件退休当前代际。
      if (roots.isRootAgentIdentity(agent)) return true;
      const currentChildRecord = records.getRecord(agent.id);
      return currentChildRecord?.agent !== void 0;
    }
    const activeRoot = roots.isRootAgentIdentity(agent) ? roots.lineage.activeRoot(agent.id) : void 0;
    // registry暂时没有对象时，已绑定的不同root代际仍优先；不能让迟到对象覆盖它。
    return activeRoot !== void 0 && activeRoot !== agent && registered !== agent;
  }

  /** root 身份代际是普通role授权的基础，不涉及恢复快照写入。 */
  function bindRootGeneration(agent) {
    if (!roots.isRootAgentIdentity(agent) || typeof agent?.id !== "string") return;
    const previous = roots.lineage.activeRoot(agent.id);
    if (previous !== void 0 && previous !== agent) roots.retireRootGeneration(previous);
    roots.lineage.activateRoot(agent);
    roots.lineage.tokenFor(agent);
    roots.rootGenerationRegistry.activate(agent.id, agent);
    roots.notificationHost.activateRoot({ rootId: agent.id, generation: roots.rootGenerationRegistry.generationOf(agent.id) });
  }

  function bindActivation(agent) {
    if (typeof agent?.id !== "string") return;
    const previousActivation = records.readChildActivation(agent.id);
    if (previousActivation?.agent !== void 0 && previousActivation.agent !== agent) {
      records.invalidateRequestRetryState(previousActivation.agent);
    }
    records.noteChildActivation(agent.id, agent);
  }

  function installExpertRuntime(agent, expert, resolvedEffort, isExpertChild) {
    effort.installEffortInjection(agent, resolvedEffort);
    if (isExpertChild === true) snapshot.installFallbackRoute(agent);
  }

  function applyExpertRecovery(agent) {
    const expert = snapshot.resolveExpertIdentity(agent);
    const resolvedEffort = effort.resolveEffortOf(agent, expert.recordedExpert);
    const { pluginChildAuthenticated, ignoredLateRecoveryChild } = records.registerExpertRecovery(agent, {
      role: expert.role,
      parentId: expert.parentId,
      isContinuable: expert.isContinuable,
      recordedExpert: expert.recordedExpert,
    });
    const isExpertChild = typeof expert.role === "string" && typeof expert.parentId === "string" && !ignoredLateRecoveryChild;
    snapshot.persistChildModel(agent, { ...expert, pluginChildAuthenticated, isExpertChild }, { effort: resolvedEffort });
    installExpertRuntime(agent, expert, resolvedEffort, isExpertChild);
  }

  function validateOrdinaryIntent(agent, source, intent) {
    if (!intent || intent.kind !== "ordinary" || intent.state !== "pending" || intent.candidates !== 0) {
      throw new Error("ordinary activation intent is missing, stale, or already consumed");
    }
    if (source !== "startup") {
      throw new Error("ordinary activation did not create a startup child Agent");
    }
    if (intent.reservedChildId !== undefined
      && (agent.id !== intent.reservedChildId
        || agent.session?.header?.id !== intent.reservedChildId
        || roots.agents.get(intent.reservedChildId) !== agent)) {
      throw new Error("ordinary activation did not create the exact reserved child Agent");
    }
    if (intent.reservedChildId === undefined && roots.agents.get(agent.id) !== agent) {
      throw new Error("ordinary activation child is not the exact registered Agent");
    }
    const parent = intent.parent;
    if (!parent || agent.session?.header?.parentSession !== parent.id
      || roots.agents.get(parent.id) !== parent
      || typeof roots.lineage?.isLiveGeneration !== "function"
      || roots.lineage.isLiveGeneration(parent, intent.rootToken) !== true) {
      throw new Error("ordinary activation parent generation is no longer live");
    }
    const roleMarker = agent.options?.[ROLE_MARKER];
    const parentMarker = agent.options?.[PARENT_MARKER];
    const providerMarker = agent.options?.[EXPERT_SUBAGENT_PROVIDER_MARKER];
    if ((roleMarker !== undefined && roleMarker !== intent.role)
      || (parentMarker !== undefined && parentMarker !== parent.id)
      || (providerMarker !== undefined && providerMarker !== intent.provider)) {
      throw new Error("ordinary activation metadata does not match its private intent");
    }
    intent.candidates = 1;
    intent.agent = agent;
    intent.state = "consumed";
    registerPluginExpertChildAgent(agent);
    guards.installExpertReportGuard(agent, { role: intent.role, parentId: parent.id, source: "ordinary-intent" });
  }

  /** 接收Host完整created payload；exact live child按 root / 普通专家分支接线。 */
  function handleAgentCreated(event) {
    const agent = event?.agent ?? event;
    const source = event?.agent === undefined ? void 0 : event.source;
    if (agent === null || typeof agent !== "object" || typeof agent.id !== "string"
      || typeof roots.agents?.get !== "function" || roots.agents.get(agent.id) !== agent || isLateActivation(agent)) return;

    if (roots.isRootAgentIdentity(agent) === true) {
      bindRootGeneration(agent);
      bindActivation(agent);
      rootWait.engageRootTurnWaitForCreatedAgent(agent);
      return;
    }

    rootWait.engageRootTurnWaitForCreatedAgent(agent);

    const intent = getOrdinaryActivationIntent?.();
    if (intent !== void 0) {
      validateOrdinaryIntent(agent, source, intent);
      try {
        bindActivation(agent);
        if (intent.recoveryRebuild === true) {
          const expert = snapshot.resolveExpertIdentity(agent);
          const resolvedEffort = effort.resolveEffortOf(agent, expert.recordedExpert);
          const isExpertChild = typeof expert.role === "string" && typeof expert.parentId === "string";
          installExpertRuntime(agent, expert, resolvedEffort, isExpertChild);
        } else {
          applyExpertRecovery(agent);
        }
      } catch (error) {
        intent.state = "failed";
        throw error;
      }
      return;
    }

    bindActivation(agent);
    if (source === "startup") return;
    applyExpertRecovery(agent);
  }

  return { handleAgentCreated };
}
