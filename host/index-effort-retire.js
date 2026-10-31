/**
 * 入口推理深度注入 + root 代际退休域（R4e · 票据 19）。
 *
 * 这一域承载两件彼此相邻、但都与「agent 生命周期边界」相关的事：
 * 1. **子代理推理深度落地**（B5）：把显式 effort 装到 child 自己的模型选择上。宿主契约在
 *    0.2.2-alpha.2 变了，因此这里按能力分支（`agent.model.select` 是否存在）：
 *    - **新版（DSH 0.2.2+，有选择 API）**：在 `agent/created` 阶段直接
 *      `agent.model.select({ provider, model, reasoningEffort })` 把档位**固化**进
 *      ModelSelection；**绝不**注册 `agent/request` listener。
 *    - **旧版（0.2.1-rc.5 及更早，只有 waterfall）**：保持迁移前的注入逻辑逐行不变——
 *      请求本身已带 effort 时不覆盖，且绝不把 adapter 的默认档固化进 settings。
 *    cold-resume 的 child 不带 marker，回落持久化 childModels 快照。
 *
 * ## 为什么新版不能再「事后注入」
 * 0.2.2 的 agent loop 在每个 step 的 preparation 里先固定 ModelSelection（无已记录选择时
 * 回落到 AgentOptions.provider/model/reasoningEffort，见 core/agent 的 model-selection），
 * 随后要求 `agent/request` waterfall 返回的 provider/model/reasoningEffort 与选择**完全
 * 一致**，否则整轮请求抛错（core/agent-loop 的 prepareRequest）。0.2.1-rc.5 没有这条
 * 断言，prepareRequest 还用 options.reasoningEffort 播种请求，因此旧做法在那时是安全的。
 * 换句话说：在本版宿主上，「创建时 options 不写 effort、由 listener 补 xhigh」必然不一致，
 * 子代理一启动就失败；档位只能在 step preparation 之前用 select() 写进选择本身。
 *
 * ## root 代际退休
 * 2. **root 代际退休**：同 id 的新 root 出现或旧 root 销毁时，按 exact Agent 对象切断
 *    旧代际的全部可恢复边界（终止快照、lineage 绑定、等待账本、fan-out 登记、admission
 *    批次与恢复记录）。迟到旧事件因此无法删除/复活同 id 的新代际。
 *
 * ## 铁律（票据 19）
 * 本模块**不接收 ctx**，也不注册任何 `ctx.on` / `ctx.effect`：三个
 * `ctx.on("agent/created" | "agent/disposed" | "agent/request-error")` 仍由 `index.js`
 * 在原注册点执行，这里只交出 handler 与命令。唯一的动态注册点是 child 自己的
 * `agent.ctx.on`（仅旧宿主的 effort 注入路径），由组合根提供的 `agent` 句柄完成
 * （与迁移前同一调用形态）；新宿主路径只调用 child 自己的 `agent.model.select`。
 *
 * ## 状态唯一 owner
 * 本模块独占 `effortDisposers`（WeakMap：exact Agent -> 释放函数）。对外只暴露
 * `disposeEffortInjection(agent)` 命令，不交出容器；`index.js` 只调用该命令。
 *
 * ## 行为等价
 * 旧宿主上的注入判定（effort === undefined / 无 scoped ctx.on / 已安装）、waterfall 的
 * "已带 effort 不覆盖" 语义逐行不变；新宿主上则换成一次幂等的 select() 调用。
 * 退休顺序（终止快照 -> 标记 dispose -> lineage -> 用户等待 ->
 * 代际 token -> 等待账本 -> fan-out 登记 -> admission -> tracker -> 代际表 -> 恢复记录）
 * 与迁移前逐行一致；任一命令缺失只影响自身分支，不改变其它边界的顺序。
 *
 * @module dsh-expert-group/host/index-effort-retire
 */
import { EFFORT_MARKER } from "./expert-guards.js";

/**
 * 记录一次「新版宿主上固化推理档失败」的诊断（自身绝不抛出）。
 *
 * 域服务的能力面是固定的 7 组（没有 logger），而这里又必须完全静默地降级：只经
 * `console.debug` 留下一条不含 prompt / 凭据 / 任务正文的线索（agent id + 错误消息），
 * 便于现场排查「档位为什么退回 adapter 默认」。console 本身不可用时整段吞掉。
 *
 * @param {object} agent - 被创建的 Agent 对象。
 * @param {*} error - select() 抛出的错误。
 */
function logEffortSelectionFailure(agent, error) {
  try {
    if (typeof console === "undefined" || typeof console.debug !== "function") return;
    const label = typeof agent?.id === "string" ? agent.id : "unknown";
    const detail = error instanceof Error ? error.message : String(error);
    console.debug("[dsh-expert-group] effort selection failed for " + label + ": " + detail);
  } catch {
    // 诊断永远不能反向影响 child 创建路径。
  }
}

/**
 * 创建推理深度注入 + root 代际退休域。
 *
 * @param {object} deps - 窄能力面（7 组）。
 * @param {object} deps.identity - 根身份与代际面：`isRootAgentIdentity`、`lineage`
 *   （releaseAgent/tokenOf）、`rootGenerationRegistry`（generationOf/retire）、
 *   `notificationHost`（retireRoot）。
 * @param {object} deps.prelude - 装配前言域：`markRootDisposed(agent)`。
 * @param {object} deps.rootWait - root 等待域：`rootTurnWaits.retire`、
 *   `forgetRootUserWait(agent)`。
 * @param {object} deps.handoff - handoff 域：`forgetParentTurnEnds`、
 *   `forgetFailedHandoffParent`、`clearPendingHandoffAdmissions`。
 * @param {object} deps.recovery - 恢复域：`prunePendingCreationsForParent`、
 *   `dropRebuildsFor`、`dropParentRecoveryRecords`。
 * @param {object} deps.delegation - 委派跟踪器：`dropParent(parentId)`。
 * @param {object} deps.fanout - fan-out 等待登记（晚绑定）：`releaseRetiredRootHandoffs(agent)`。
 * @returns {object} 能力面：effort 解析/安装/释放 + 退休命令。
 */
export function createEffortRetireDomain({ identity, prelude, rootWait, handoff, recovery, delegation, fanout }) {
  /**
   * exact Agent -> 释放函数；同一 agent 只处理一次。
   *
   * 旧宿主存 `agent/request` listener 的 dispose；新宿主（选择已固化，没有 listener 可撤）
   * 存一个空函数，只用于「已安装」幂等判定。
   */
  const effortDisposers = new WeakMap();

  /**
   * 解析子代理应注入的推理深度（B5）：优先 child.options 上的 EFFORT_MARKER；
   * cold-resume 的专家 child 不带 marker（dsh-subagent 冷恢复只还原
   * provider/model），回落持久化 childModels 快照的 reasoningEffort。
   * 无显式 effort 返回 undefined（绝不把 adapter 的默认档固化进 settings）。
   * @param {object} agent - 被创建的 Agent 对象。
   * @param {object} [recordedExpert] - 已校验的专家快照记录（含 role/parentId/
   *   continuable），仅对 cold-resume 专家 child 传入。
   * @returns {*} 显式 effort 或 undefined。
   */
  function resolveEffortOf(agent, recordedExpert) {
    const marked = agent?.options?.[EFFORT_MARKER];
    if (marked !== void 0) return marked;
    if (recordedExpert !== void 0) return recordedExpert.reasoningEffort;
    return void 0;
  }

  /**
   * 新版宿主（DSH 0.2.2+）路径：把显式 effort 直接固化进该 Agent 的 ModelSelection。
   *
   * 为什么必须是 select() 而不是 waterfall：新版 step preparation 先固定选择，再要求
   * `agent/request` waterfall 的结果与它逐字段一致；提前固化是唯一不触发一致性断言的写法。
   *
   * 边界（全部 fail-soft，绝不影响 child 创建）：
   * - provider/model 取自 agent.options（创建期真实路由）；缺失或不是非空字符串就跳过，
   *   绝不猜一个 provider；
   * - effort 同样必须是非空字符串：空串/非字符串代表"档位未声明"，绝不能把它当成一个
   *   真实档位塞进 ModelSelection（否则 0.2.2+ 的 step preparation 会把空串当作已固定的
   *   档位，请求侧再想回落到 adapter 默认就已经不一致了）；
   * - select 抛错（宿主实现异常、selection 形状被拒）只留一条 debug 线索，然后返回 false：
   *   档位退化成 adapter 默认，但 child 仍能启动；
   * - 成功后登记一个空释放函数，保持「同一 agent 只装一次」的幂等语义（select 没有 listener
   *   可撤销）；agent/disposed 的释放路径因此不需要区分两种宿主。
   *
   * @param {object} agent - 被创建的 Agent 对象（带 model.select）。
   * @param {*} effort - 要固化的显式推理深度。
   * @returns {boolean} 已固化返回 true；跳过或失败返回 false。
   */
  function selectEffortOnModernHost(agent, effort) {
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider !== "string" || provider.length === 0) return false;
    if (typeof model !== "string" || model.length === 0) return false;
    // 与 fan-out/自动恢复写入真实字段的判据对齐：空串与非字符串都不是"显式档位"，
    // 直接跳过（不调用 select），让选择保持"未指定"、由 adapter 解析默认档。
    if (typeof effort !== "string" || effort.length === 0) return false;
    try {
      agent.model.select({ provider, model, reasoningEffort: effort });
    } catch (error) {
      logEffortSelectionFailure(agent, error);
      return false;
    }
    effortDisposers.set(agent, () => {});
    return true;
  }

  /**
   * 让子代理的显式推理深度生效（幂等：同一 agent 只处理一次）。
   *
   * 按宿主能力分支（原因见模块头部「为什么新版不能再事后注入」）：
   * - 有 `agent.model.select`（0.2.2+）：创建期固化选择，**不**注册 agent/request 监听；
   * - 否则（0.2.1-rc.5 及更早）：保持既有 waterfall 注入——请求本身已带 effort 时不覆盖，
   *   也不修改 agent.options 原对象（B5）。
   *
   * @param {object} agent - 被创建的 Agent 对象。
   * @param {*} effort - 要注入的显式推理深度。
   * @returns {boolean} 已处理（或已处理过）返回 true。
   */
  function installEffortInjection(agent, effort) {
    if (effort === void 0) return false;
    if (effortDisposers.has(agent)) return true;
    // 新版宿主：选择 API 存在即按「固化」处理；旧宿主没有该 API，继续走 waterfall。
    if (typeof agent?.model?.select === "function") return selectEffortOnModernHost(agent, effort);
    if (typeof agent?.ctx?.on !== "function") return false;
    const dispose = agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      if (resolved.reasoningEffort !== void 0) return resolved;
      return { ...resolved, reasoningEffort: effort };
    });
    effortDisposers.set(agent, dispose);
    return true;
  }

  /**
   * 释放某个 exact Agent 的 effort 注入（幂等）。
   *
   * 与迁移前的两处 disposed 清理逐行一致：先 delete 再调用，释放函数抛错被吸收
   * （child 已经销毁，清理失败不能影响其它收敛路径）。
   * @param {object} agent - 正在销毁的 Agent 对象。
   */
  function disposeEffortInjection(agent) {
    const dispose = effortDisposers.get(agent);
    if (dispose === void 0) return;
    effortDisposers.delete(agent);
    try { dispose(); } catch { /* child 已销毁时释放监听器抛错只影响该 exact agent 的清理，不能打断其它收敛路径；当前为有意降级，若需观测请走宿主 logger（本模块无 logger）。 */ }
  }

  /**
   * root 代际退休时摘除它持有的 fan-out 等待登记。
   *
   * 为什么必须做：登记记录的归属凭据是注册当时捕获的 exact Agent 对象。旧代际退休后
   * 它的分片会随 agent/disposed 一起收敛，**不会再产生 task_settled**；若记录仍留在表里
   * 并保持 active，补建路径就可能（在极端的同 id replacement 场景下）被误导。这里统一
   * 标记 released 并删除：等待本身由 rootTurnWaits.retire 取消，登记表只负责「这个
   * parentTaskId 的当前代次是谁」，绝不继承旧代际的等待原因。
   *
   * @param {object} previous - 正在退休的 exact root Agent。
   */
  function releaseFanoutHandoffRecordsForRetiredRoot(previous) {
    // 容器 owner 在 host/index-expert-tools-fanout.js：这里只调一条退休命令。
    fanout.releaseRetiredRootHandoffs(previous);
  }

  /**
   * 让一个 exact root Agent 的代际整体退休（顺序与迁移前逐行一致）。
   * @param {object} previous - 正在退休的 exact root Agent。
   */
  function retireRootGeneration(previous) {
    if (!identity.isRootAgentIdentity(previous) || typeof previous.id !== "string") return;
    const previousGeneration = identity.rootGenerationRegistry.generationOf(previous.id);
    // 终止快照按旧 root 的 exact generation 退休；迟到旧事件不能删除同 id 新代际。
    identity.notificationHost.retireRoot(previous.id, previousGeneration);
    // 同 id 的 R2 出现时先切断 R1 的所有可恢复边界；WeakSet 只保留对象
    // 身份用于迟到 microtask 判定，不把已销毁 root 长期挂在容器里。
    prelude.markRootDisposed(previous);
    identity.lineage.releaseAgent(previous);
    rootWait.forgetRootUserWait(previous);
    const previousToken = identity.lineage.tokenOf(previous);
    if (previousToken !== void 0) previousToken.active = false;
    // 代际退休：取消该 root 的全部等待（等待者以 released:false 收口）、移除监听与引用。
    // 旧代际的迟到事件不会再命中任何记录，因此无法释放新 waiter。
    rootWait.rootTurnWaits.retire(previous, "root-generation-retired");
    // 旧代际的分片不会再产生 task_settled：必须同时摘除它持有的 fan-out 登记，
    // 否则那些「永远等不到结算」的登记会让后续补建路径被误导。
    releaseFanoutHandoffRecordsForRetiredRoot(previous);
    handoff.forgetParentTurnEnds(previous);
    handoff.forgetFailedHandoffParent(previous);
    handoff.clearPendingHandoffAdmissions(previous);
    delegation.dropParent(previous.id);
    identity.rootGenerationRegistry.retire(previous.id, previous);
    recovery.prunePendingCreationsForParent(previous);
    recovery.dropRebuildsFor(previous);
    recovery.dropParentRecoveryRecords(previous);
  }

  return {
    resolveEffortOf,
    installEffortInjection,
    disposeEffortInjection,
    releaseFanoutHandoffRecordsForRetiredRoot,
    retireRootGeneration,
  };
}
