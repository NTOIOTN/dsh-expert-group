/**
 * 入口推理深度注入 + root 代际退休域（R4e · 票据 19）。
 *
 * 这一域承载两件彼此相邻、但都与「agent 生命周期边界」相关的事：
 * 1. **子代理推理深度注入**（B5）：把显式 effort 以 `agent/request` waterfall 的形式
 *    挂到 child 自己的 ctx 上；请求本身已带 effort 时不覆盖，且绝不把 adapter 的默认档
 *    固化进 settings。cold-resume 的 child 不带 marker，回落持久化 childModels 快照。
 * 2. **root 代际退休**：同 id 的新 root 出现或旧 root 销毁时，按 exact Agent 对象切断
 *    旧代际的全部可恢复边界（终止快照、lineage 绑定、等待账本、fan-out 登记、admission
 *    批次与恢复记录）。迟到旧事件因此无法删除/复活同 id 的新代际。
 *
 * ## 铁律（票据 19）
 * 本模块**不接收 ctx**，也不注册任何 `ctx.on` / `ctx.effect`：三个
 * `ctx.on("agent/created" | "agent/disposed" | "agent/request-error")` 仍由 `index.js`
 * 在原注册点执行，这里只交出 handler 与命令。唯一的动态注册点是 child 自己的
 * `agent.ctx.on`，由组合根提供的 `agent` 句柄完成（与迁移前同一调用形态）。
 *
 * ## 状态唯一 owner
 * 本模块独占 `effortDisposers`（WeakMap：exact Agent -> 释放函数）。对外只暴露
 * `disposeEffortInjection(agent)` 命令，不交出容器；`index.js` 只调用该命令。
 *
 * ## 行为等价
 * 注入判定（effort === undefined / 无 scoped ctx.on / 已安装）、waterfall 的
 * "已带 effort 不覆盖" 语义、退休顺序（终止快照 -> 标记 dispose -> lineage -> 用户等待 ->
 * 代际 token -> 等待账本 -> fan-out 登记 -> admission -> tracker -> 代际表 -> 恢复记录）
 * 与迁移前逐行一致；任一命令缺失只影响自身分支，不改变其它边界的顺序。
 *
 * @module dsh-expert-group/host/index-effort-retire
 */
import { EFFORT_MARKER } from "./expert-guards.js";

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
  /** exact Agent -> agent/request 释放函数；同一 agent 只注入一次。 */
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
   * 安装 agent/request waterfall 注入推理深度（幂等：同一 agent 只装一次；
   * 请求本身已带 effort 时不覆盖）。不修改 agent.options 原对象（B5）。
   * @param {object} agent - 被创建的 Agent 对象。
   * @param {*} effort - 要注入的显式推理深度。
   * @returns {boolean} 已安装（或已装过）返回 true。
   */
  function installEffortInjection(agent, effort) {
    if (effort === void 0 || typeof agent?.ctx?.on !== "function") return false;
    if (effortDisposers.has(agent)) return true;
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
    try { dispose(); } catch {}
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
