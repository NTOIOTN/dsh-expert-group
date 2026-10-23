/**
 * 入口 agent/created 事件接线域（R4e · 票据 19）。
 *
 * 这是 `ctx.on("agent/created")` 的**纯 handler**：判定新出现的 Agent 属于哪一类
 * （fan-out child / root / 普通专家 child），并把它接入对应的边界。
 *
 * 分支顺序是行为契约（与迁移前逐行一致）：
 * 1. `engageRootTurnWaitForCreatedAgent`：任何 child 出现都意味着 root 可能有工作未结束；
 * 2. **fan-out child 必须先于普通专家分支**：marker 缺失的 cold child 只有在持久化记录具备
 *    完整 fan-out 身份时才走同一路径；身份预检失败立即 fail-closed（不登记、不装 guard、
 *    不回落普通专家恢复分支）；
 * 3. registry 已指向另一个 Agent 的迟到旧 Activation 直接短路；
 * 4. root 出现时激活代际、退休同 id 旧代际并补登记 fan-out 等待；
 * 5. 剩余路径解析专家身份、登记恢复记录、写 child_models 与安装 scoped guard。
 *
 * ## 铁律（票据 19）
 * 本模块**不接收 ctx**：`ctx.on("agent/created")` 的注册仍由 `index.js` 在原注册点执行，
 * 这里只返回 `handleAgentCreated(agent)`。
 *
 * ## 状态唯一 owner
 * 本模块不持容器：根代际表、等待账本、恢复记录、fan-out Host 都各自由其域模块拥有，
 * 这里只调用它们的命令。
 *
 * @module dsh-expert-group/host/index-agent-created
 */
import { isFanoutAgent, isFanoutIdentity } from "../fanout-host.js";
import { ROLE_MARKER, PARENT_MARKER, registerPluginExpertChildAgent } from "./expert-guards.js";

/**
 * 创建 agent/created handler。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与 agent id）。
 * @param {object} deps.rootWait - root 等待域：`engageRootTurnWaitForCreatedAgent(agent)`。
 * @param {object} deps.fanout - fan-out 面：`consumeFanoutRestore`、`getFanoutHost`（晚绑定）、
 *   `reconcileGoalHandoffs`（= fanoutWaits.reconcileFanoutGoalHandoffs）。
 * @param {object} deps.roots - 根代际面（identity + prelude + 退休命令的同一关注点）：
 *   `agents`、`lineage`（activeRoot/activateRoot/tokenFor）、`rootGenerationRegistry`
 *   （activate/generationOf）、`notificationHost`（activateRoot）、`isRootAgentIdentity`、
 *   `retireRootGeneration`。
 * @param {object} deps.guards - 组合根的 guard 安装 adapter（F6 留 index.js）：
 *   `installExpertReportGuard(agent, identity)`。
 * @param {object} deps.effort - effort 域：`resolveEffortOf`、`installEffortInjection`。
 * @param {object} deps.records - 恢复登记域：`registerExpertRecovery`、`getRecord`、
 *   `readChildActivation`、`noteChildActivation`、`invalidateRequestRetryState`。
 * @param {object} deps.snapshot - child 快照域：`resolveExpertIdentity`、`readChildModel`、
 *   `persistChildModel`、`installFallbackRoute`。
 * @returns {{handleAgentCreated: (agent: object) => void}} handler 能力面。
 */
export function createAgentCreatedHandler({ logger, rootWait, fanout, roots, guards, effort, records, snapshot }) {
  /**
   * fan-out child 的 created 路由：身份预检 -> 登记 exact Agent -> scoped guard -> Host 接管。
   * 预检失败时 fail-closed 返回，绝不回落普通专家恢复分支。
   * @param {object} agent - exact Agent 对象。
   * @param {object|undefined} recordedFanoutChild - 持久化 child 记录（可能缺失）。
   */
  function handleFanoutChildCreated(agent, recordedFanoutChild) {
    const fanoutHost = fanout.getFanoutHost();
    // 身份预检必须发生在**任何副作用之前**：下面的 registerPluginExpertChildAgent /
    // guard 安装 / handleAgentCreated 都会改状态。仅靠 handleAgentCreated 的返回值挡不住
    // 错误 marker —— false 只表示「没有对应的 live attempt」，被复制/篡改的
    // parentTaskId、shardId、attempt 或指向别的 root 的 parent 同样得到 false，却已经让
    // 错误 marker 拿到了 exact Agent 登记与 scoped guard（本函数的注释下方即为原漏洞面）。
    // 预检与 runtime 内部复用同一份判定（marker/persisted identity + 实际 parent +
    // active record 的 canonical parent），失败即 fail-closed 终止本 created 路由。
    // 预检**能力本身**缺失（fanoutHost 未装配，或旧 runtime 没有该方法）与「预检不通过」
    // 必须同形 fail-closed：调用方只认 `ok === true`，undefined / 非对象判定一律按
    // fanout_precheck_unavailable 拒绝，绝不能当成通过——否则残缺 runtime 或旧替身会让
    // 错误 marker 直接拿到 exact Agent 登记与 scoped guard。
    const identityVerdict = typeof fanoutHost?.precheckFanoutChildIdentity === "function"
      ? fanoutHost.precheckFanoutChildIdentity(agent, recordedFanoutChild)
      : void 0;
    if (identityVerdict === void 0 || identityVerdict === null || identityVerdict.ok !== true) {
      const rejectReason = typeof identityVerdict?.reason === "string" && identityVerdict.reason.length > 0
        ? identityVerdict.reason
        : "fanout_precheck_unavailable";
      logger.warn("dsh-expert-group: fan-out child identity precheck rejected (" + rejectReason
        + ") for " + (typeof agent?.id === "string" ? agent.id : "unknown"));
      // 直接终止：绝不登记/装 guard，也**不回落**普通专家恢复分支——那条路径会把
      // 不可信（或无从证明）的身份快照当成可自动恢复的专家 child 继续使用。
      fanout.consumeFanoutRestore("agent-created-precheck-rejected", fanoutHost?.restore());
      return;
    }
    // fan-out child 也必须在**本分支**完成 exact Agent 登记与 scoped guard 安装：
    // 本分支在早期通用 created listener 之后、普通专家分支之前 return，早期 listener
    // 运行时该 Agent 尚未登记（guard 会 fail-closed 不安装）；而 record 已终态清理的
    // cold-resume child 也不会再触发 fan-out 的 onAgentCreated 回调，只依赖那条路径
    // 会让 report/send_message/deny 硬防线在冷恢复后整体缺失。
    //
    // 身份仍以 exact Agent 对象为准：role/parentId marker 只是可复制 metadata，只有
    // 这里登记的实例才允许安装 guard；普通（非 fan-out）child 不经过本分支，边界不放宽。
    registerPluginExpertChildAgent(agent);
    // role/parentId 优先取当前 marker；cold-resume 的 agent.options 只有 provider/model，
    // 因此回落到 trusted persisted fanout 快照（能走到本分支即已由 isFanoutAgent /
    // isFanoutIdentity 证明完整 fan-out 身份）。历史快照缺少普通 parentId 时，可在
    // 同一前提下用 fanoutParentAgentId 兼容补齐。
    const fanoutRole = agent?.options?.[ROLE_MARKER] ?? recordedFanoutChild?.role;
    const fanoutParentId = agent?.options?.[PARENT_MARKER]
      ?? recordedFanoutChild?.parentId
      ?? (isFanoutIdentity(recordedFanoutChild) ? recordedFanoutChild.fanoutParentAgentId : void 0);
    guards.installExpertReportGuard(agent, { role: fanoutRole, parentId: fanoutParentId, source: "fanout" });
    fanoutHost?.handleAgentCreated(agent, recordedFanoutChild);
    fanout.consumeFanoutRestore("agent-created-fanout", fanoutHost.restore());
  }

  /**
   * 绑定 Activation / root 代际。
   * @param {object} agent - exact Agent 对象。
   * @returns {boolean} true 表示「迟到旧 Activation」，调用方必须短路本次 created。
   */
  function bindActivation(agent) {
    if (typeof agent?.id === "string") {
      const registered = roots.agents.get(agent.id);
      const currentChildRecord = records.getRecord(agent.id);
      // registry 已指向另一个 Agent 时，这是迟到旧 Activation；不能让它
      // 覆盖当前 child/root generation。cold resume 的新 Agent 必须已成为 registry 当前值。
      if (registered !== void 0 && registered !== agent && currentChildRecord?.agent !== void 0) return true;
    }
    if (roots.isRootAgentIdentity(agent) && typeof agent?.id === "string") {
      // root generation 以 exact Agent 对象识别；同 id 的新 root 覆盖当前代际。
      const previous = roots.lineage.activeRoot(agent.id);
      if (previous !== void 0 && previous !== agent) roots.retireRootGeneration(previous);
      roots.lineage.activateRoot(agent);
      roots.lineage.tokenFor(agent);
      roots.rootGenerationRegistry.activate(agent.id, agent);
      roots.notificationHost.activateRoot({ rootId: agent.id, generation: roots.rootGenerationRegistry.generationOf(agent.id) });
      // root 重新出现（上面的 restore() 已把 deferred 任务恢复回来）且 lineage 绑定刚刚
      // 建立，此刻才能按 root 归属补登记 fan-out 等待工作。
      fanout.reconcileGoalHandoffs();
    }
    if (typeof agent?.id === "string") {
      // replacement 先取消旧 Agent 的 request fallback，再覆盖 Activation 身份。
      const previousActivation = records.readChildActivation(agent.id);
      if (previousActivation?.agent !== void 0 && previousActivation.agent !== agent) {
        records.invalidateRequestRetryState(previousActivation.agent);
      }
      records.noteChildActivation(agent.id, agent);
    }
    return false;
  }

  /**
   * agent/created 的纯 handler。
   * @param {object} agent - 新建的 Agent 对象。
   */
  function handleAgentCreated(agent) {
    // root turn 等待的介入点：任何在某个 live root 之下新建的子代理（角色 child、fan-out
    // 分片、嵌套后代）都意味着「该 root 的当前 turn 可能还有工作没结束」。这里只登记
    // 「该 root 已进入等待体系」，是否真的等待仍由 host/turn-wait.js 的静止判定决定；
    // 因此纯 continue_parent_turn 与模型遗漏 finalize 的路径也能被 agent/turn-stopping
    // 兜底覆盖，而不需要为它们各写一套账本。
    rootWait.engageRootTurnWaitForCreatedAgent(agent);
    // fan-out child 必须先于旧 recovery 分支路由；marker 缺失的 cold child
    // 只能在精确 child_models 记录具备完整 fan-out identity 时走同一条路径。
    const recordedFanoutChild = typeof agent?.id === "string" ? snapshot.readChildModel(agent.id) : void 0;
    const fanoutChild = isFanoutAgent(agent) || isFanoutIdentity(recordedFanoutChild);
    if (fanoutChild) {
      handleFanoutChildCreated(agent, recordedFanoutChild);
      return;
    }
    fanout.consumeFanoutRestore("agent-created", fanout.getFanoutHost()?.restore());
    if (bindActivation(agent)) return;
    const expert = snapshot.resolveExpertIdentity(agent);
    const resolvedEffort = effort.resolveEffortOf(agent, expert.recordedExpert);
    const { pluginChildAuthenticated, ignoredLateRecoveryChild } = records.registerExpertRecovery(agent, {
      role: expert.role,
      parentId: expert.parentId,
      isContinuable: expert.isContinuable,
      recordedExpert: expert.recordedExpert,
    });
    // 专家 child（带 ROLE/PARENT marker 或 cold-resume 快照补全）登记自动恢复
    // 记录：turn/end 失败/空返回时以父代理身份自动续跑；父会话与其他子代理
    // 无 marker，不受影响。
    // P2：已清理 record 的迟到 rebuild child 不写入快照，避免后续 cold-resume
    // 把一个父代理已放弃的 child 当成可复用任务重新登记。
    const isExpertChild = typeof expert.role === "string" && typeof expert.parentId === "string" && !ignoredLateRecoveryChild;
    snapshot.persistChildModel(agent, { ...expert, pluginChildAuthenticated, isExpertChild }, { effort: resolvedEffort });
    effort.installEffortInjection(agent, resolvedEffort);
    // 运行期降级：只给专家 child 装 route 覆盖（与 effort 注入并排，幂等）。
    // root 永远没有候选链，装上去只会给每次请求多一层空转发，因此不装。
    // 未降级时 listener 原样透传，不改变任何既有请求形状。
    if (isExpertChild === true) snapshot.installFallbackRoute(agent);
  }

  return { handleAgentCreated };
}
