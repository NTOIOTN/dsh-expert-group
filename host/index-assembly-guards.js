/**
 * 入口装配段 2（票据 21b · R4-21）：root/child scoped guard 安装、恢复记录域、
 * 运行期模型降级动态注册 adapter、自动恢复执行流与卸载清理。
 *
 * 注册点（ctx.on / ctx.effect）仍由入口按本模块返回的**有序数组**逐项登记；
 * 本模块只构造 adapter（函数体与选项对象），不接触 ctx 本体。
 *
 * ## 动态注册点（F6 / 降级覆盖）
 * - `installRootStructuredPathGuard` 用 `agent.ctx.effect` + `agent.ctx.tools.guard`：
 *   那是**每个 root Agent 自己的 scoped ctx**，不是插件 ctx，因此仍在本模块内安装。
 * - `installModelFallbackRouteOverride` 用 `agent.ctx.on(..., { prepend: true })`：
 *   同样是 child/root 作用域的动态注册点，幂等安装与 disposer 记账都在域服务里。
 *
 * @module dsh-expert-group/host/index-assembly-guards
 */
import { rootStructuredPathGuard } from "../shared/structured-path.js";
import { AUTO_RECOVERY_LIMIT, TASK_BINDING_LIMIT } from "../shared/recovery-ledger.js";
import {
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  EXPERT_INHERIT_CONTEXT_MARKER,
} from "../shared/model-route.js";
import {
  DENY_MARKER,
  PERSONA_MARKER,
  expertGuardDenyNames,
  hasPluginAdmissionProof,
  isPluginExpertChildIdentity,
  isRegisteredPluginExpertChild,
  resolveExpertReportIdentity,
  validPersonaMarker,
} from "./expert-guards.js";
import { installExpertChildComposition, installExpertReportGuard } from "./expert-child-composition.js";
import { createRecoveryModule } from "./recovery.js";
import { createIndexRecoveryDomain } from "./index-recovery.js";
import {
  createAutoRecoveryDispatch,
  createAutoRecoveryFlow,
  createRecoveryChildRebuild,
  createRecoveryEventBridge,
} from "./index-auto-recovery.js";

/**
 * root 专属结构化文件工具 guard + 插件专家 child 的 scoped guard / composition 兜底。
 *
 * 注册顺序（迁移前一致）：一条 `ctx.effect`（内部 `ctx.on("agent/created")`，并在注册时
 * 对既有 root 立刻安装 guard 快照）。
 *
 * @param {object} state 装配状态容器。
 * @param {object} caps 入口具名能力面。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleGuards(state, caps) {
  const { logger } = state;
  const { agents } = state.services;
  const { delegationTracker, forgetRootDisposed, rootUserWaitGuard } = state;

  /**
   * root 专属结构化文件工具 guard 的 owner cleanup。必须挂在每个 root Agent
   * 自身的 ctx 上，不能调用全局 ctx.tools.guard，否则会把 child 也挡住；guard
   * 快照实时读取 tracker，活动专家结束后自然放行后续 root 文件操作。
   */
  state.rootStructuredGuardDisposers = new Map();
  // 每个 child 的 guard 绑定到其 scoped tools；Map 还负责插件卸载时的显式清理。
  state.expertReportGuardDisposers = new Map();
  state.rootStructuredGuardStopping = false;

  function isRootAgentForStructuredGuard(agent) {
    return typeof agents?.roots === "function" && agents.roots().includes(agent);
  }
  /**
   * 返回 root 结构化工具 guard 可用的 workspace root。
   * 当前插件生命周期没有安全的 cwd 注入；禁止读取 ctx.cwd 或
   * agent.session.header.cwd 这类懒注入 getter，否则会中断 SessionRuntime.create。
   * 缺少 root 时，guard 仍会校验绝对路径和 workspace-wide 范围，
   * 但不对相对影响范围做隐式 rebasing。
   */
  function workspaceRootForStructuredGuard() {
    return void 0;
  }
  function installRootStructuredPathGuard(agent) {
    if (state.rootStructuredGuardStopping || !isRootAgentForStructuredGuard(agent)
      || state.rootStructuredGuardDisposers.has(agent)) return;
    forgetRootDisposed(agent);
    if (typeof agent?.ctx?.effect !== "function" || typeof agent?.ctx?.tools?.guard !== "function") return;
    const workspaceRoot = workspaceRootForStructuredGuard(agent);
    let ownerCleanup;
    ownerCleanup = agent.ctx.effect(() => {
      const disposeGuard = agent.ctx.tools.guard((execution) => {
        const handoffRejection = rootUserWaitGuard(agent, execution);
        if (handoffRejection !== void 0) return handoffRejection;
        return rootStructuredPathGuard(execution, delegationTracker.listActiveTasks(agent.id), agent.id, workspaceRoot);
      });
      return () => {
        try { disposeGuard?.(); } finally {
          if (state.rootStructuredGuardDisposers.get(agent) === ownerCleanup) state.rootStructuredGuardDisposers.delete(agent);
        }
      };
    }, "dsh-expert-group: root structured path guard");
    state.rootStructuredGuardDisposers.set(agent, ownerCleanup);
  }
  /**
   * 为已认证的插件专家 child 安装 scoped guard 与缺失的 child composition。
   *
   * 两者都挂在同一个 child scope，并共用 expertReportGuardDisposers 生命周期：
   * - guard：report/send_message/deny 的执行期硬防线（原有行为）；
   * - composition 兜底：旧 RC1 startLocal 初次路径丢弃 request.persona/toolFilter 时，
   *   在 agent/created（首条任务消息提交前）补齐系统提示词 persona 与工具 deny 边界。
   * 只有 exact Agent 认证 + 有效角色身份才允许安装；普通 child、root 与未认证迟到
   * child 既没有登记也没有身份，因此不受影响。
   */
  function installExpertReportGuardForAgent(agent, resolvedIdentity) {
    // marker/parent 只是可复制的 metadata；只有 acceptance/created 流程登记过的
    // exact Agent 才允许安装 scoped surface，避免普通 child 被误伤。
    if (!isRegisteredPluginExpertChild(agent)
      || isRootAgentForStructuredGuard(agent)
      || state.expertReportGuardDisposers.has(agent)) return;
    // 先在安装函数外确认身份，避免 installExpertReportGuard 返回的 no-op 被当成
    // 已安装并永久记录；身份监听器稍后可用已解析 role/parentId 重试。
    const resolvedOrRecorded = resolvedIdentity ?? resolveExpertReportIdentity(
      agent?.options,
      agent?.id,
      (childId) => state.source().childModels?.[childId],
    );
    // 冷恢复：身份来自调用方快照时补上 admission 证据，
    // 否则 guard 会因目录已无该角色而整体跳过，等于丢掉 deny/persona 边界。
    const persistedRecord = typeof agent?.id === "string" ? state.source().childModels?.[agent.id] : void 0;
    const identity = resolvedOrRecorded !== void 0
      && resolvedOrRecorded !== null
      && resolvedOrRecorded.admissionProof !== true
      && hasPluginAdmissionProof(persistedRecord)
      ? { ...resolvedOrRecorded, admissionProof: true }
      : resolvedOrRecorded;
    if (!isPluginExpertChildIdentity(identity)) return;
    const disposers = [];
    if (typeof agent?.ctx?.tools?.guard === "function") {
      disposers.push(installExpertReportGuard(agent.ctx, (childId) => state.source().childModels?.[childId], identity, agent));
    }
    // cold-resume 的 agent.options 只有 provider/model：与 guard 一致，优先当前 marker，
    // 回落到 DEG 自有 child_models 的 admission deny 快照，最后才是角色静态清单。
    const persistedDeny = typeof agent?.id === "string" ? state.source().childModels?.[agent.id]?.[DENY_MARKER] : void 0;
    const denyOptions = agent?.options?.[DENY_MARKER] !== void 0
      ? agent?.options
      : persistedDeny !== void 0
        ? { ...agent?.options, [DENY_MARKER]: persistedDeny }
        : agent?.options;
    // composition 兜底的 persona 与 deny marker 用同一套恢复优先级：
    // 1) 新建 child 的 agent.options marker —— 本次 admission 解析出的完整人格；
    // 2) cold-resume 的 DEG child_models 快照记录值 —— settings 覆盖可能在 child 创建
    //    之后被改过，既有 child 必须继续使用记录人格，而不是被新覆盖改写；
    // 3) 只有旧记录确实缺少该字段时，才在当前 admission 边界重新解析（与 rebuild 同语义）。
    // 记录值与 marker 都经过形状校验：malformed 快照一律回退，不让异常逃逸到 child 创建路径。
    const recordedPersona = typeof agent?.id === "string"
      ? validPersonaMarker(state.source().childModels?.[agent.id]?.[PERSONA_MARKER])
      : void 0;
    const childPersona = validPersonaMarker(agent?.options?.[PERSONA_MARKER])
      ?? recordedPersona
      ?? state.resolvePersonaForAdmissionOrRecorded(identity.role);
    // 兼容层独立于 tools.guard：精简替身缺少 guard 时仍按可用能力补 composition。
    const compositionDispose = installExpertChildComposition(agent?.ctx, {
      deny: [...(expertGuardDenyNames(denyOptions, identity) ?? [])],
      persona: childPersona,
      // restrict 判据用该 child 自己的 scope 视图（tools.view(agent).restrictableNames）：
      // 与工具服务 restrict() 内部同一判据，因此不会把 restrict 会拒绝的名字交出去，
      // 也能覆盖只落在祖先层（agent preset）的名字。Agent 由调用方显式传入，
      // 绝不从 childCtx 读未注入的懒 agent getter。
      scope: agent,
      logger,
    });
    if (typeof compositionDispose === "function") disposers.push(compositionDispose);
    // 什么都没安装就不登记，保留「身份监听器稍后可用已解析身份重试」的既有语义。
    if (disposers.length === 0) return;
    state.expertReportGuardDisposers.set(agent, () => {
      for (const dispose of disposers) {
        try { dispose(); } catch (error) {
          logger.warn("dsh-expert-group: expert child scoped surface cleanup failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
    });
  }
  state.installRootStructuredPathGuard = installRootStructuredPathGuard;
  state.installExpertReportGuardForAgent = installExpertReportGuardForAgent;

  // 既有 root 在插件加载早于/晚于 agent 创建两种时序都要覆盖；agent.ctx.effect
  // 负责随 root 生命周期释放 guard，插件 effect 负责卸载时撤销创建监听与残余 owner。
  return [{
    kind: "effect",
    label: "dsh-expert-group: root structured guard lifecycle",
    factory: () => {
      const stopCreated = caps.subscribe("agent/created", ({ agent }) => {
        installRootStructuredPathGuard(agent);
        installExpertReportGuardForAgent(agent);
      });
      const roots = typeof agents?.roots === "function" ? agents.roots() : [];
      for (const agent of roots) {
        installRootStructuredPathGuard(agent);
      }
      return () => {
        state.rootStructuredGuardStopping = true;
        stopCreated?.();
        for (const cleanup of state.rootStructuredGuardDisposers.values()) {
          try { cleanup?.(); } catch (error) {
            logger.warn("dsh-expert-group: root structured guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
          }
        }
        state.rootStructuredGuardDisposers.clear();
        for (const cleanup of state.expertReportGuardDisposers.values()) {
          try { cleanup?.(); } catch (error) {
            logger.warn("dsh-expert-group: expert report guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
          }
        }
        state.expertReportGuardDisposers.clear();
      };
    },
  }];
}

/**
 * 自动恢复（自愈监督）登记表 + 记录生命周期 + 模型降级动态注册 adapter（票据 17）。
 *
 * 状态唯一 owner 在 host/index-recovery.js；本段只做组合根的窄能力装配，并交出
 * `recovery.addDisposeHook` 与一条 `ctx.effect` 注册描述（原注册顺序：hook 先于 effect）。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleRecovery(state) {
  const { logger } = state;
  const { agents } = state.services;
  const { host, delegationTracker, handoffDomain, finalizeDomain, isLiveRootAgent, isRootAgentIdentity } = state;

  const recovery = createRecoveryModule({
    limit: AUTO_RECOVERY_LIMIT,
    taskBindingLimit: TASK_BINDING_LIMIT,
    // 上下文继承（票据 29）：恢复上下文额外保存目标 subagent provider 与继承标记，
    // 供持久化记录尚未落地时按原通道重建；缺失时保持旧上下文形状。
    subagentProviderMarker: EXPERT_SUBAGENT_PROVIDER_MARKER,
    inheritContextMarker: EXPERT_INHERIT_CONTEXT_MARKER,
  });
  state.recovery = recovery;
  const recoveryDomain = createIndexRecoveryDomain({
    host,
    agents,
    delegation: delegationTracker,
    handoff: handoffDomain,
    finalize: finalizeDomain,
    // settings/storage 域在 apply 后段才创建：只交出调用期解析的取值函数
    // （与迁移前「同一闭包内晚绑定」的语义一致）。
    storage: {
      readSnapshot: () => state.source(),
      writeChildModelPatch: (...args) => state.writeChildModelPatch(...args),
    },
    identity: { isLiveRootAgent, isRootAgentIdentity },
    // 动态注册点仍由本段的 adapter 完成：域服务只要求「切换前确实装上了覆盖落点」。
    ensureModelRouteOverride: (agent) => installModelFallbackRouteOverride(agent),
  });
  state.recoveryDomain = recoveryDomain;
  Object.assign(state, recoveryDomain);

  /**
   * 运行期降级 listener 的**动态注册 adapter**。
   *
   * handler 与 disposer 记账都在域服务里，这里只负责幂等安装与时机。agent 缺少
   * scoped ctx.on 时返回 false，调用方据此拒绝切换（拿不到落点的覆盖会让 loop 用
   * 同一路由重发，白耗候选预算）。
   */
  function installModelFallbackRouteOverride(agent) {
    if (typeof agent?.ctx?.on !== "function") return false;
    if (recoveryDomain.hasModelRouteOverrideDisposer(agent)) return true;
    const dispose = agent.ctx.on("agent/request", recoveryDomain.modelRouteOverrideHandler(agent), { prepend: true });
    recoveryDomain.noteModelRouteOverrideDisposer(agent, dispose);
    return true;
  }
  state.installModelFallbackRouteOverride = installModelFallbackRouteOverride;

  // recovery 自己持有重建上下文，但恢复 op 的 timer/controller 仍由入口调度层创建；
  // 通过统一 hook 在插件卸载时先取消这些外部资源，再让迟到 promise 观察到 disposed。
  // 注册顺序与迁移前一致：addDisposeHook 先于 ctx.effect。
  recovery.addDisposeHook(() => recoveryDomain.clearAllRecoveryState());
  return [{
    kind: "effect",
    label: "dsh-expert-group: recovery lifecycle",
    factory: () => () => recovery.dispose(),
  }];
}

/**
 * 自动恢复（自愈监督）执行段（票据 17）：流控 / 重建 / 投递 / 事件桥与卸载清理。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleAutoRecovery(state) {
  const { logger } = state;
  const { agents, subagents } = state.services;
  const {
    host,
    delegationTracker,
    recoveryDomain,
    recovery,
    handoffDomain,
    rootWaitDomain,
    notificationHost,
    rootGenerationRegistry,
    roleCatalog,
  } = state;

  const recoveryIdentity = { agents, isLiveRootAgent: state.isLiveRootAgent, lineage: host.lineage };
  const recoveryFlow = createAutoRecoveryFlow({
    logger,
    records: recoveryDomain,
    delegation: delegationTracker,
    recovery,
    handoff: handoffDomain,
    identity: recoveryIdentity,
    // 投递组在下方创建：只交出调用期解析的窄能力（避免两组定义顺序耦合）。
    dispatch: { dispatchRecovery: (...args) => recoveryDispatch.dispatchRecovery(...args) },
  });
  const recoveryChildRebuild = createRecoveryChildRebuild({
    records: recoveryDomain,
    recovery,
    identity: recoveryIdentity,
    // settings/storage 读面在 apply 后段才就绪：只交出调用期解析的取值函数。
    storage: { readSnapshot: () => state.source() },
    experts: {
      roleCatalog,
      resolvePersonaForAdmission: state.resolvePersonaForAdmission,
      resolvePersistedSubagentTarget: (...args) => state.expertCore.resolvePersistedSubagentTarget(...args),
      startExpertActivation: (...args) => state.expertCore.startExpertActivation(...args),
      contextInheritanceError: (...args) => state.expertCore.contextInheritanceError(...args),
    },
    structured: { markStructuredRequest: (...args) => state.expertCore.markStructuredRequest(...args) },
    agents,
    delegation: delegationTracker,
  });
  const recoveryDispatch = createAutoRecoveryDispatch({
    logger,
    delegation: delegationTracker,
    identity: recoveryIdentity,
    subagents,
    flow: recoveryFlow,
    rebuild: recoveryChildRebuild,
  });
  const recoveryBridge = createRecoveryEventBridge({
    logger,
    records: recoveryDomain,
    handoff: handoffDomain,
    identity: { agents, isLiveRootAgent: state.isLiveRootAgent },
    rootWait: rootWaitDomain,
    notifications: { notificationHost, rootGenerationRegistry },
    // fan-out Host 是晚绑定槽：只交出取值函数，避免装配期捕获 undefined。
    fanout: {
      getFanoutHost: () => state.fanoutHost,
      reconcileUnbarrieredFanoutHandoffs: (...args) => state.fanoutWaits?.reconcileUnbarrieredFanoutHandoffs(...args),
    },
    delegation: delegationTracker,
  });
  // 显式续作（role 工具的 steer 路径）与自动恢复共用同一投递 seam。
  state.handleChildTurnEnd = recoveryFlow.handleChildTurnEnd;
  state.supersedePendingRecoveryOps = recoveryFlow.supersedePendingRecoveryOps;
  state.sendMessageToExistingChild = recoveryDispatch.sendMessageToExistingChild;

  return [
    // 三个事件 handler 的注册仍在原注册顺序（inserted → session/event → claimed）。
    { kind: "on", event: "agent/inbox/inserted", handler: (payload) => recoveryBridge.onInboxInserted(payload) },
    // 触发通道 2：session/event 的 child turn/end 仍只负责终态结算；root turn/end 才是
    // 终止快照的唯一提交点。microtask 避开 Session.append 发布重入，并在执行前校验
    // exact root Agent/Session/generation 身份。
    { kind: "on", event: "session/event", handler: (session, event) => recoveryBridge.onSessionEvent(session, event) },
    // 触发通道 2（B2 路径 B）：消息被 inbox 认领（claim）即记录 message.id -> turn。
    // 覆盖「user/message 落盘前发生 pre-step reject/取消/异常」的归属缺口——
    // 该 turn 里没有目标 user/message，messageIdsOfTurn 永远找不到归属。
    // payload 由 dsh-agent-loop 提供 { message, turn } 并附加 agent。
    // child 新 Activation 的 claimed 会重新写入，旧值按 messageId 覆盖即可；
    // record 生命周期内不清空（S2：上限 CLAIMED_LIMIT 条，超限按插入序淘汰最旧）。
    { kind: "on", event: "agent/inbox/claimed", handler: (payload) => recoveryBridge.onInboxClaimed(payload) },
    // 插件卸载：清理恢复状态与全部活动范围，防止状态泄漏；
    // dropRecoveryRecord 内部会清理所有 pending op（B7）。
    {
      kind: "effect",
      label: "dsh-expert-group: recovery registry",
      factory: () => () => {
        state.stopRootWait();
        // 卸载：取消全部 root 的等待（等待者以 released:false 收口）、移除监听与引用。
        state.rootTurnWaits.dispose();
        state.clearRootWaitInvalidators();
        state.fanoutWaits?.clearHandoffWaitRecords();
        // 结构化声明映射只服务本进程派发；卸载时没有可复用的 activation 契约。
        state.fanoutCaches?.clearAllFanoutOutputSchemas();
        state.fanoutCaches?.clearAllFanoutRoutes();
        state.expertCore?.clearPendingStructuredPatches();
        // 结构化结果的有界重试定时器必须随卸载清除，避免关闭后仍有回调写已失效的 storage。
        state.expertCore?.clearAllStructuredRetries();
        // per-shard 排队镜像随账本一起丢弃（票据 26）：dispose 已收口全部 waiter 与 works。
        state.fanoutWaits?.clearShardWaitRecords();
        state.clearAllParentTurnEnds();
        // pendingHandoffAdmissions 只是 host 索引；cohort 另外持有 root/entry 引用，
        // 卸载时必须先遍历所有 known root 并清空共享 entries，再丢弃数组索引。
        for (const root of state.listHandoffAdmissionRoots()) {
          state.clearHandoffAdmissionRoot(root);
        }
        host.handoff.clear();
        state.clearAllHandoffFailures();
        // WeakSet 无需强制 clear；不保留 root 强引用。
        state.clearChildActivationStates();
        for (const childId of state.recordIds()) {
          // 插件卸载不是进程重启边界：只丢弃 record，不释放仍可能被写入的范围保护。
          state.dropRecoveryRecord(childId, "插件已卸载，等待被中止", void 0, { releaseScope: false });
        }
      },
    },
  ];
}
