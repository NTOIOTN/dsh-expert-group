/**
 * 入口 fan-out 工具域（R4d · 票据 18）。
 *
 * 这一域承载「通用 fan-out 工具」的全部运行期状态与命令：
 * - 等待账本：任务级 handoff 登记（代次不可复用）、per-shard 排队镜像、生命周期事件消费、
 *   冷恢复补登记（`reconcile*`）；
 * - 有界声明缓存：提交时的 outputSchema 声明与预检路由；
 * - 任务命令：submit / continuation 句柄 / 多轮续作 / 拒绝文案 / 父任务反馈文本；
 * - 运行期装配：`createFanoutRuntimeModule` 的 options 与生命周期 seam
 *   （buildRequest / startContinuable / continueMessage / interrupt / onAgentCreated）。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**、不做任何注册。`ctx.effect` 卸载注册与
 * `consumeFanoutRestore("runtime-wired", …)` 仍由 `index.js` 在原装配点执行；
 * 域只交出 `{ host, close }` 与命令/只读投影。
 *
 * ## 状态唯一 owner
 * 本模块独占：`fanoutTurnWaitRecords` / `fanoutTurnWaitSequence`、
 * `fanoutShardWaitRecords`、`fanoutOutputSchemas`、`fanoutRoutes`。
 * 容器本体不出模块：对外只有登记/结算/补登记命令、有界缓存命令与只读查询。
 *
 * ## 行为等价
 * 登记代次规则、幂等短路、事件结算点、schema/route 清理边界、续作拒绝码与回执形状
 * 全部与迁移前逐行一致；`index.js` 侧只换成命令调用。
 *
 * @module dsh-expert-group/host/index-expert-tools-fanout
 */
import { buildExpertTaskPrompt } from "./expert-task-prompt.js";
import { createFanoutRuntimeModule } from "./fanout-runtime.js";
import {
  createFanoutRuntime,
  FANOUT_ATTEMPT_MARKER,
  FANOUT_MARKER,
  FANOUT_PARENT_AGENT_MARKER,
  FANOUT_PARENT_TASK_MARKER,
  FANOUT_SHARD_MARKER,
} from "../fanout-host.js";
import { PRODUCER_SOURCE_KIND } from "./plugin-identity.js";
import { normalizeRoleConcurrencyLimit, normalizeRoleTimeoutMs } from "./settings-schema.js";
import { shadowMarkerFields } from "./send-message-shadow.js";
import {
  CONTINUABLE_MARKER,
  DENY_MARKER,
  EFFORT_MARKER,
  PARENT_MARKER,
  PERSONA_MARKER,
  ROLE_MARKER,
  ensureExpertSendMessageDenied,
  registerPluginExpertChildAgent,
  validPersonaMarker,
} from "./expert-guards.js";
import {
  EXPERT_INHERIT_CONTEXT_MARKER,
  EXPERT_ROUTE_MARKER,
  EXPERT_ROUTE_SNAPSHOT_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  normalizeModelRouteMarker,
  normalizeModelSelection,
} from "../shared/model-route.js";
// 派发期路由冻结（票据 03）：fan-out 在 attempt 进入 running 之前同步冻结快照。
// 单独成模块是为了让 scheduler 的 seam 只依赖纯函数，不再从本文件多引一条 shared 依赖。
import {
  fanoutRouteSnapshotRecordOf,
  frozenFanoutRouteOf,
  prepareFanoutAttempt,
} from "./fanout-dispatch-route.js";
import { OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";
import { PROVIDER_ROUTE_CHANGED, SHARD_TERMINAL_STATUSES } from "../fanout.js";
import { FANOUT_BUDGET, truncateFeedbackText } from "../resource-budget.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * per-shard 排队等待账本（票据 26）：parentTaskId -> { agent, shardIds }。
 *
 * 为什么需要它：role/provider 名额不足时，分片只是「排队」——没有 running child，
 * 因而没有 child 创建/状态事件能证明它还在等待。若不登记进 root wait 账本，
 * root turn 会在排队工作真正开始前就被判定静止并收口（用户看到「任务完成」，
 * 实际分片还没跑）。
 *
 * @param {object} deps - 窄能力面（3 组：rootWait / runtime / caches）。
 * @returns {object} per-shard 等待账本能力面。
 */
export function createFanoutShardWaits({ rootWait, runtime, caches }) {
  const { isRootWaitStopping, isLiveRootAgent } = rootWait;
  // track/settle 由 root 等待域持有；沿用同名窄命令保持迁移前代码逐行不变。
  const rootTurnWaits = {
    track: (...args) => rootWait.track(...args),
    settle: (...args) => rootWait.settle(...args),
  };
  const { clearFanoutOutputSchemas, clearFanoutRoute } = caches;

  /**
   * per-shard 排队等待账本（票据 26）：parentTaskId -> { agent, shardIds: Set<string> }。
   *
   * 为什么需要它：role/provider 名额不足时，分片只是「排队」——没有 running child，
   * 因而没有 child 创建/状态事件能证明它还在等待。若不登记进 root wait 账本，
   * root turn 会在排队工作真正开始前就被判定静止并收口（用户看到「任务完成」，
   * 实际分片还没跑）。
   *
   * 记账边界：
   * - 只在 shard.status === "queued" 时登记（running/终态不登记）；
   * - 结算点固定为：shard 进入 running、shard 进入任一终态（成功/失败/取消/超时/
   *   中断）、以及 task_settled / onParentSettled 的兜底结算；
   * - agent 保存登记当时的 exact root Agent 对象。账本的 settle 需要对象身份，
   *   按 id 现查可能拿到同 id 的 replacement 代际，从而错误结算到别的 root。
   * - works 的真相始终是 rootWait 内部表；这里的 shardIds 只是本地镜像，
   *   用于兜底结算与"是否还有排队项"的快速判断，两者由同一组调用点同步维护。
   */
  const fanoutShardWaitRecords = new Map();
  /** 终态集合的快速判定（与 fanout.js 的 isTerminalShardStatus 同源词表）。 */
  const FANOUT_SHARD_TERMINAL_SET = new Set(SHARD_TERMINAL_STATUSES);

  /**
   * 为任务中所有**排队中**的分片登记等待工作（幂等）。
   *
   * 调用点：submit / continuation / retry / 冷恢复补登记——它们都经由
   * registerFanoutGoalHandoff 进入，因此这里能覆盖全部"任务重新变为 pending"的路径。
   *
   * @param {object} agent - exact root Agent。
   * @param {string} parentTaskId - 父任务 id。
   * @param {object} task - manager 的权威任务快照（含 shards[].status）。
   * @returns {number} 本次新登记的分片数（幂等重复登记返回 0）。
   */
  function registerFanoutShardWaits(agent, parentTaskId, task) {
    if (isRootWaitStopping() || !isLiveRootAgent(agent)) return 0;
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return 0;
    if (task === null || typeof task !== "object" || !Array.isArray(task.shards)) return 0;
    const shards = task.shards.filter((shard) => shard?.status === "queued");
    if (shards.length === 0) return 0;
    let record = fanoutShardWaitRecords.get(parentTaskId);
    if (record === void 0 || record.agent !== agent) {
      record = { agent, shardIds: new Set() };
      fanoutShardWaitRecords.set(parentTaskId, record);
    }
    let registered = 0;
    for (const shard of shards) {
      const shardId = typeof shard.shardId === "string" ? shard.shardId : "";
      if (shardId.length === 0) continue;
      // 先入本地镜像再 track：track 对同一键幂等，因此重复调用不会重复计数。
      const wasKnown = record.shardIds.has(shardId);
      const key = rootWait.track(agent, { kind: "fanout-shard", parentTaskId, shardId });
      if (key === void 0) continue;
      record.shardIds.add(shardId);
      if (!wasKnown) registered += 1;
    }
    return registered;
  }

  /**
   * 精确结算一个排队分片的工作（shard 进入 running 或任一终态时调用）。
   *
   * @param {string} parentTaskId - 父任务 id。
   * @param {string} shardId - 分片 id。
   * @returns {boolean} 是否确实结算了一项。
   */
  function settleFanoutShardWait(parentTaskId, shardId) {
    if (isRootWaitStopping()) return false;
    const record = fanoutShardWaitRecords.get(parentTaskId);
    if (record === void 0 || !record.shardIds.has(shardId)) return false;
    record.shardIds.delete(shardId);
    const settled = rootWait.settle(record.agent, { kind: "fanout-shard", parentTaskId, shardId });
    if (record.shardIds.size === 0) fanoutShardWaitRecords.delete(parentTaskId);
    return settled;
  }

  /**
   * 兜底结算该任务**全部**剩余排队分片工作。
   *
   * 用途：task_settled（正常情况下每一项已被 shard 事件精确结算，这里是事件丢失或
   * 关闭路径的兜底）与 onParentSettled（任务真实终态边界）。幂等：没有剩余项时
   * 什么都不做。
   *
   * @param {string} parentTaskId - 父任务 id。
   * @returns {number} 本次结算掉的分片数。
   */
  function settleAllFanoutShardWaits(parentTaskId) {
    const record = fanoutShardWaitRecords.get(parentTaskId);
    if (record === undefined) return 0;
    if (isRootWaitStopping()) {
      // 插件正在卸载：账本会被整体 dispose，只需清掉本地镜像，不再调用 settle。
      fanoutShardWaitRecords.delete(parentTaskId);
      return 0;
    }
    const shardIds = [...record.shardIds];
    fanoutShardWaitRecords.delete(parentTaskId);
    let settled = 0;
    for (const shardId of shardIds) {
      if (rootWait.settle(record.agent, { kind: "fanout-shard", parentTaskId, shardId })) settled += 1;
    }
    return settled;
  }

  /** root 代际退休：丢弃它名下的 per-shard 镜像（账本本身由 rootWait.retire 收口）。 */
  function dropFanoutShardWaitsForRoot(previous) {
    for (const [parentTaskId, record] of [...fanoutShardWaitRecords]) {
      if (record?.agent !== previous) continue;
      fanoutShardWaitRecords.delete(parentTaskId);
    }
  }

  /**
   * manager 生命周期事件的只读消费（票据 26）：维护 per-shard 排队账本。
   *
   * 事件语义（与 fanout.js 的 emitShardStatus/aggregateTask 同源）：
   * - shard_status_changed 且 status === "running" 或终态 → 精确结算该分片；
   * - task_settled → 兜底结算该任务剩余分片工作（防事件丢失/关闭路径）；
   * - 其它事件（task_registered / 诊断事件）不改账本。
   *
   * 只在"确实命中本地镜像"时才调用 settle，因此重复事件、迟到事件和与
   * onParentSettled 的重复兜底都是安全 no-op。
   *
   * @param {unknown} event - manager 事件（来自 fanout-host 的 onEvent seam）。
   */
  function handleFanoutLifecycleEvent(event) {
    if (event === null || typeof event !== "object") return;
    if (event.type === "shard_status_changed") {
      const status = event.status;
      if (status !== "running" && !FANOUT_SHARD_TERMINAL_SET.has(status)) return;
      settleFanoutShardWait(event.parentTaskId, event.shardId);
      return;
    }
    if (event.type === "task_settled") {
      // 结构化声明（票据 30）：正常完成/部分失败的任务仍可能被 in-process 手工 retry
      // （同一 parentTaskId 重新进入 pending），此时必须复用同一 schema；只有已取消、
      // 不存在 retry 路径的任务才在结算时清理。回收/关闭仍无条件清理。
      let terminalTask;
      try { terminalTask = runtime.getFanoutHost()?.getTask?.(event.parentTaskId); } catch { terminalTask = null; }
      if (terminalTask?.parentCancelRequested === true) {
        clearFanoutOutputSchemas(event.parentTaskId);
        clearFanoutRoute(event.parentTaskId);
      }
      settleAllFanoutShardWaits(event.parentTaskId);
    }
  }

  /** 卸载清理：丢弃 per-shard 排队镜像（容器不出模块）。 */
  function clearShardWaitRecords() {
    fanoutShardWaitRecords.clear();
  }

  return {
    registerFanoutShardWaits,
    settleFanoutShardWait,
    settleAllFanoutShardWaits,
    dropFanoutShardWaitsForRoot,
    handleFanoutLifecycleEvent,
    clearShardWaitRecords,
  };
}

/**
 * 等待账本：任务级 handoff 登记 + per-shard 排队镜像 + 生命周期事件 + 补登记。
 *
 * @param {object} deps - 窄能力面（4 组：rootWait / agents / runtime / caches）。
 * @returns {object} 等待账本能力面。
 */
export function createFanoutWaitLedger({ rootWait, agents, runtime, caches, shards }) {
  const { isRootWaitStopping, isLiveRootAgent } = rootWait;
  // track/settle 由 root 等待域持有；这里沿用同名窄命令，迁移前代码因此逐行保持原样。
  const rootTurnWaits = {
    track: (...args) => rootWait.track(...args),
    settle: (...args) => rootWait.settle(...args),
  };
  const { clearFanoutOutputSchemas, clearFanoutRoute } = caches;
  // per-shard 排队镜像的 owner 是同文件的 createFanoutShardWaits；这里只走它的命令。
  const { registerFanoutShardWaits, dropFanoutShardWaitsForRoot } = shards;
  /**
   * fan-out 是否处于终态（manager 权威状态）。restore 与登记路径共用同一判定。
   */
  function fanoutTaskIsTerminal(task) {
    return task !== null && typeof task === "object"
      && (typeof task.settledAt === "number" || (typeof task.status === "string" && task.status !== "pending"));
  }

  /**
   * fan-out 等待登记表：parentTaskId -> { attempt, agent, state }。
   *
   * 为什么需要**登记代次**：manager 的 retryShard / continuation 会把已终态任务带回
   * pending，而首次 settle 已经结算过旧代次的工作项。若 retry 复用同一个键，等待登记表
   * 会把「retry 期间的新工作」误认为「旧工作仍未结算」，从而在分片跑完前就放行。
   * 因此每次登记取**独立代次**，键编码为 fanout:<id>:<attempt>；旧代次的迟到结算只命中
   * 旧键，绝不会结算新代次。
   *
   * state 三态：pending（刚登记，尚未确认任务仍在跑）→ active（任务确实非终态，工作项已登记）
   * → released（已结算，不可复活）。用三态而不是 boolean：异步窗口里的迟到回调不能把已经
   * 释放的记录重新置回 active。
   */
  const fanoutTurnWaitRecords = new Map();
  let fanoutTurnWaitSequence = 0;
  // 24 是纯资源上界（只淘汰已释放记录）；代次分配不依赖本表，因此小上限不影响正确性。
  const FANOUT_HANDOFF_LIMIT = 24;

  /** 分配一个**不可复用**的全局登记代次。 */
  function nextFanoutHandoffSequence() {
    fanoutTurnWaitSequence += 1;
    return fanoutTurnWaitSequence;
  }

  /** 释放后按资源边界清理：只淘汰「已释放且 manager 已无该任务」的旧记录。 */
  function pruneFanoutHandoffRecords() {
    if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
    for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
      if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
      if (record?.state !== "released") continue;
      if (runtime.getFanoutHost()?.getTask(parentTaskId) !== null) continue;
      fanoutTurnWaitRecords.delete(parentTaskId);
    }
    // 极端情况（全部任务都还在 manager 表里且都是已释放记录）下仍按插入序淘汰最旧的
    // 已释放项。淘汰是安全的：代次来自全局序号（不复用），被淘汰记录的迟到 settle 只会
    // 走安全 no-op。
    for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
      if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
      if (record?.state !== "released") continue;
      fanoutTurnWaitRecords.delete(parentTaskId);
    }
  }

  /**
   * 该 parentTaskId 的当前登记是否仍由 **exact live root** 持有。
   *
   * 三个条件缺一不可：record.agent 是注册当时捕获的 exact Agent 对象（对象身份无法被
   * 同 id 伪造）；它仍是当前 live root；runtime.getFanoutHost().ownsTask 能证明「活动绑定 + 绑定代际
   * token 仍 live」。记录的三态不参与身份判定。
   */
  function fanoutHandoffRecordIsOwnedByLiveRoot(agent, parentTaskId) {
    if (isRootWaitStopping() || !isLiveRootAgent(agent)) return void 0;
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return void 0;
    const record = fanoutTurnWaitRecords.get(parentTaskId);
    if (record === void 0 || record.agent !== agent) return void 0;
    if (typeof runtime.getFanoutHost()?.ownsTask !== "function" || runtime.getFanoutHost().ownsTask(agent, parentTaskId) !== true) return void 0;
    return record;
  }

  /**
   * 为一个 fan-out 父任务登记等待工作。
   *
   * @param {object} parent - exact live root Agent。
   * @param {{parentTaskId?:string,task?:object,accepted?:boolean,duplicate?:boolean}} result - submit/retry 结果。
   * @returns {boolean} 是否登记成功。
   */
  function registerFanoutGoalHandoff(parent, result) {
    if (isRootWaitStopping() || !isLiveRootAgent(parent)) return false;
    if (result?.accepted === false || result?.duplicate === true) return false;
    const parentTaskId = result?.parentTaskId;
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
    // 已终态快照：未来不会再有 task_settled，登记等待工作会永远无法结算。
    if (fanoutTaskIsTerminal(result?.task)) return false;
    const existing = fanoutTurnWaitRecords.get(parentTaskId);
    // per-shard 排队工作与任务级登记相互独立：即使任务级工作已登记（重复 submit /
    // 恢复竞争），排队分片仍必须各自登记（track 幂等），否则当前这批排队分片
    // 在任务级工作之外没有任何可结算依据。
    registerFanoutShardWaits(parent, parentTaskId, result?.task);
    // 未释放的既有登记（pending/active）幂等短路：duplicate submit 或 restore 竞争都不得重复登记。
    if (existing !== void 0 && existing.state !== "released") return true;
    const attempt = nextFanoutHandoffSequence();
    fanoutTurnWaitRecords.set(parentTaskId, { attempt, agent: parent, state: "active" });
    pruneFanoutHandoffRecords();
    return rootWait.track(parent, { kind: "fanout", parentTaskId, attempt }) !== void 0;
  }

  /**
   * fan-out 父任务真实终态时**精确结算**它的等待工作。
   *
   * 只结算当前登记的代次：旧代次的迟到结算命中的键与新代次不同，因此不会提前放行仍在
   * retry 的任务。没有登记记录时为安全 no-op。
   *
   * @returns {boolean} 是否确实结算。
   */
  function releaseFanoutGoalHandoff(agent, parentTaskId) {
    if (isRootWaitStopping()) return false;
    const record = fanoutTurnWaitRecords.get(parentTaskId);
    // exact Agent 身份必须先于任何状态写入校验；旧代回调不得污染当前记录。
    if (record === void 0 || record.state === "released" || record.agent !== agent) return false;
    record.state = "released";
    return rootWait.settle(agent, { kind: "fanout", parentTaskId, attempt: record.attempt });
  }

  /**
   * fan-out 任务「重新回到 pending」时的等待工作再登记入口。
   *
   * 两个触发源共用同一语义（任务重新变成 pending，root 必须继续等待）：
   * - 手工重试（RPC fanout-retry-shard / fanout-retry）；
   * - 多轮复用（fanout 工具的 continuation 参数，同一 parentTaskId 的新一轮）。
   */
  function registerFanoutRetryGoalHandoff(parent, parentTaskId, task) {
    if (isRootWaitStopping() || !isLiveRootAgent(parent)) return false;
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
    return registerFanoutGoalHandoff(parent, { accepted: true, parentTaskId, task });
  }

  /**
   * 冷恢复/重启后为「已在运行、但本进程还没有登记」的 fan-out 任务补登记等待工作。
   *
   * 判定完全基于当前事实（manager 权威任务 + exact live root 归属），因此可重入、
   * 可合并：registerFanoutGoalHandoff 自己对未释放记录幂等短路。
   *
   * 只处理本进程尚无活动登记的父任务；owner 已销毁时跳过（不凭空为不存在的 root 登记）。
   *
   * @returns {number} 本次补登记的任务数。
   */
  function reconcileFanoutGoalHandoffs() {
    if (isRootWaitStopping() || !runtime.getFanoutHost()) return 0;
    let reconciled = 0;
    for (const task of runtime.getFanoutHost().listTasks()) {
      const parentTaskId = task?.parentTaskId;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) continue;
      const existing = fanoutTurnWaitRecords.get(parentTaskId);
      if (existing !== void 0 && existing.state !== "released") continue;
      const ownerId = runtime.getFanoutHost().ownerOf(parentTaskId);
      if (typeof ownerId !== "string" || ownerId.length === 0) continue;
      const agent = agents.get(ownerId);
      // root 已销毁：不凭空恢复不存在的 root。
      if (agent === void 0 || !isLiveRootAgent(agent)) continue;
      // 终态任务不会再有 task_settled：只标记已释放，绝不登记等待工作。
      if (fanoutTaskIsTerminal(task)) {
        if (existing !== void 0) existing.state = "released";
        continue;
      }
      if (registerFanoutGoalHandoff(agent, { accepted: true, parentTaskId, task })) reconciled += 1;
    }
    return reconciled;
  }

  /**
   * 为「已在运行、但还没有任何等待登记」的 fan-out 任务补登记（兜底路径）。
   *
   * 触发方式刻意做成「最小、可重入、可合并」：本函数不做任何自己的状态记账，只把当前
   * 事实合起来判定，因此可以被 root run 边界事件反复调用而不产生副作用放大。
   *
   * 归属边界：只处理本进程真实登记过的 parentTaskId（没有 record 就不猜）；record.agent
   * 必须是 exact live root 对象，且 runtime.getFanoutHost().ownsTask 能证明活动绑定与绑定代际 token
   * 仍 live；任务必须是 manager 的**非终态**任务。
   *
   * @returns {number} 本次补登记的任务数。
   */
  function reconcileUnbarrieredFanoutHandoffs() {
    if (isRootWaitStopping() || !runtime.getFanoutHost()) return 0;
    if (fanoutTurnWaitRecords.size === 0) return 0;
    let reconciled = 0;
    for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
      if (record?.state !== "pending" && record?.state !== "released") continue;
      const agent = record.agent;
      const owned = fanoutHandoffRecordIsOwnedByLiveRoot(agent, parentTaskId);
      if (owned === void 0 || owned !== record) continue;
      const task = runtime.getFanoutHost().getTask(parentTaskId);
      if (task === null || fanoutTaskIsTerminal(task)) continue;
      // 复用提交路径的登记入口：记录已被标记 released 时不会被幂等短路，因此这是一次
      // 真实的新代次登记。传入**权威任务快照**而不是伪造的 pending 视图。
      if (record.state === "released") fanoutTurnWaitRecords.delete(parentTaskId);
      if (registerFanoutGoalHandoff(agent, { accepted: true, parentTaskId, task })) reconciled += 1;
    }
    return reconciled;
  }

  /**
   * root 代际退休：标记并丢弃该 exact root 持有的任务级登记与 per-shard 镜像。
   *
   * 等待本身由 rootTurnWaits.retire 取消；登记表只负责「这个 parentTaskId 的当前代次是谁」，
   * 绝不继承旧代际的等待原因。调用点在 index.js 的 retireRootGeneration。
   *
   * @param {object} previous - 正在退休的 exact root Agent。
   */
  function retireHandoffRecordsForRoot(previous) {
    for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
      if (record?.agent !== previous) continue;
      record.state = "released";
      fanoutTurnWaitRecords.delete(parentTaskId);
    }
    // per-shard 排队镜像同样随代际退休丢弃（票据 26）：账本本身由 rootTurnWaits.retire
    // 整体收口，这里只清理 Host 侧的本地镜像。
    dropFanoutShardWaitsForRoot(previous);
  }

  /**
   * 任务级登记的只读投影（回收 RPC 据此判定 referenced_by_wait）。
   *
   * @param {string} parentTaskId - 父任务 id。
   * @returns {{state: string}|undefined} 冻结的只读投影；没有登记时 undefined。
   */
  function handoffRecordState(parentTaskId) {
    const record = fanoutTurnWaitRecords.get(parentTaskId);
    if (record === void 0) return void 0;
    return Object.freeze({ state: record.state });
  }

  /** 已 released 且已不可寻址的登记：回收后顺手清掉（容器不出模块）。 */
  function forgetReleasedHandoffRecord(parentTaskId) {
    const record = fanoutTurnWaitRecords.get(parentTaskId);
    if (record === undefined || record.state !== "released") return;
    fanoutTurnWaitRecords.delete(parentTaskId);
  }

  /** 卸载清理：丢弃任务级 handoff 登记（容器不出模块）。 */
  function clearHandoffWaitRecords() {
    fanoutTurnWaitRecords.clear();
  }


  return {
    // per-shard 镜像与生命周期事件由 shards 分组持有，这里只做转发（单一 owner）。
    settleAllFanoutShardWaits: shards.settleAllFanoutShardWaits,
    handleFanoutLifecycleEvent: shards.handleFanoutLifecycleEvent,
    clearShardWaitRecords: shards.clearShardWaitRecords,
    registerFanoutGoalHandoff,
    registerFanoutRetryGoalHandoff,
    releaseFanoutGoalHandoff,
    reconcileFanoutGoalHandoffs,
    reconcileUnbarrieredFanoutHandoffs,
    retireHandoffRecordsForRoot,
    handoffRecordState,
    forgetReleasedHandoffRecord,
    clearHandoffWaitRecords,
    // 只读判定：任务终态回调据此跳过不存在的 root（账本 owner 仍是 root 等待域）。
    isStopping: () => isRootWaitStopping(),
  };
}

/**
 * fan-out 声明缓存：outputSchema 声明与提交前路由的有界内存映射（单一 owner）。
 *
 * @param {object} deps - 窄能力面（2 组：storage / runtime）。
 * @returns {object} 声明缓存能力面。
 */
export function createFanoutDeclarationCaches({ storage, runtime }) {
  /**
   * fan-out 结构化声明（票据 30）的 Host 侧有界映射：parentTaskId -> shardId -> schema。
   *
   * schema 原文只进入派发请求与该内存表，绝不写进 manager 的持久化 payload 或事件；
   * 任务结算/回收/关闭时清理，冷恢复后表为空即视为无法恢复 schema。
   */
  const fanoutOutputSchemas = new Map();
  const FANOUT_SCHEMA_TASK_LIMIT = 64;

  function cacheFanoutOutputSchemas(parentTaskId, declarations) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    if (!(declarations instanceof Map) || declarations.size === 0) return;
    if (!fanoutOutputSchemas.has(parentTaskId) && fanoutOutputSchemas.size >= FANOUT_SCHEMA_TASK_LIMIT) {
      const oldest = fanoutOutputSchemas.keys().next().value;
      if (oldest !== undefined) fanoutOutputSchemas.delete(oldest);
    }
    fanoutOutputSchemas.set(parentTaskId, new Map(declarations));
  }

  function fanoutOutputSchemaFor(parentTaskId, shardId) {
    const shards = fanoutOutputSchemas.get(parentTaskId);
    return shards?.get(shardId);
  }

  function clearFanoutOutputSchemas(parentTaskId) {
    if (typeof parentTaskId === "string" && parentTaskId.length > 0) fanoutOutputSchemas.delete(parentTaskId);
  }

  function clearAllFanoutOutputSchemas() {
    fanoutOutputSchemas.clear();
  }

  /**
   * fan-out 提交前路由的 Host 侧有界映射（票据 24 fallback × 票据 26 provider 名额）。
   *
   * 为什么需要第二张表：fanout 工具在提交前已经执行过一次真实预检（primary -> 候选），
   * 得到**实际**选中的 provider/model；而 manager 的 buildRequest 是逐 attempt 独立
   * 调用的，若让它在 admission 时重新解析，就可能：
   * - 因为 primary 此刻恢复可用而换回另一个 provider，导致任务的 provider 归属
   *   （提交时已固化、用于 provider 名额）与实际运行 provider 不一致；
   * - 重复执行 fallback，放大模型解析成本与降级计数语义的分歧。
   *
   * 因此提交成功后（**同步**，早于 manager 的 microtask drain）把预检路由写到本表，
   * buildRequest 优先使用它。表只含 provider/model/路由 marker，不含 prompt/凭据/schema。
   *
   * 生命周期与 fanoutOutputSchemas 完全一致：任务取消、回收、关闭时清理；完成/部分失败
   * 的任务保留到同一进程内的手工 retry 结束（冷启动后表为空，只能重新解析）。
   */
  const fanoutRoutes = new Map();
  const FANOUT_ROUTE_TASK_LIMIT = 64;

  /**
   * 归一预检路由为可缓存形状；非法（缺 selection/marker）返回 undefined。
   *
   * 接受两种形状：预检结果（selection + 扁平 marker 字段）与缓存条目
   * （{selection, marker}），这样提交路径与已有缓存条目可以走同一入口。
   */
  function normalizedFanoutRoute(route) {
    const selection = normalizeModelSelection(route?.selection);
    const marker = normalizeModelRouteMarker(route?.marker ?? route);
    if (selection === undefined || marker === undefined) return undefined;
    return { selection, marker };
  }

  /** 有界写入：同一 parentTaskId 重复写入只刷新值，不新增键。 */
  function cacheFanoutRoute(parentTaskId, route) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    const normalized = normalizedFanoutRoute(route);
    if (normalized === undefined) return;
    if (!fanoutRoutes.has(parentTaskId) && fanoutRoutes.size >= FANOUT_ROUTE_TASK_LIMIT) {
      const oldest = fanoutRoutes.keys().next().value;
      if (oldest !== undefined) fanoutRoutes.delete(oldest);
    }
    fanoutRoutes.set(parentTaskId, normalized);
  }

  /** 读取该任务提交时固化的预检路由（缺失表示冷恢复/旧任务/已清理）。 */
  function fanoutRouteFor(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return undefined;
    return fanoutRoutes.get(parentTaskId);
  }

  function clearFanoutRoute(parentTaskId) {
    if (typeof parentTaskId === "string" && parentTaskId.length > 0) fanoutRoutes.delete(parentTaskId);
  }

  function clearAllFanoutRoutes() {
    fanoutRoutes.clear();
  }

  /**
   * 派发前 provider 一致性校验（fail-closed）。
   *
   * 任务的 provider 归属只在提交时确定一次；admission 解析出的实际 provider 必须与之
   * 相同。不一致时**绝不**继续启动 child——继续会把 running 名额记到错误 provider 名下，
   * 比直接失败更糟。任务没有 provider 归属（旧快照/未配置模型）时不参与校验。
   */
  function assertFanoutProviderRouteUnchanged(parentTaskId, route) {
    let task;
    try { task = runtime.getFanoutHost()?.getTask?.(parentTaskId); } catch { task = null; }
    const taskProvider = typeof task?.provider === "string" ? task.provider.trim() : "";
    if (taskProvider.length === 0) return;
    const actualProvider = typeof route?.selection?.provider === "string" ? route.selection.provider : "";
    if (actualProvider === taskProvider) return;
    const error = new Error("fan-out provider 路由在派发前发生变化：任务提交时固化的 provider 与实际解析不一致，已拒绝启动 child");
    error.name = "ProviderRouteChangedError";
    error.code = PROVIDER_ROUTE_CHANGED;
    error.reason = "provider_route_changed";
    throw error;
  }

  /**
   * 该 fan-out attempt 的历史是否声明过 schema（用于冷恢复/结算后手工重试）。
   *
   * 只读 manager 快照与 child_models；当前 attempt 本身的 childId 也纳入（restore 会把
   * 上一轮 childId 复制到新 attempt），但当前 attempt 之后的记录绝不会被误读。
   */
  function fanoutSchemaWasRequestedBefore(input) {
    if (!Number.isSafeInteger(input?.attempt) || input.attempt < 1) return false;
    const task = typeof runtime.getFanoutHost()?.getTask === "function" ? runtime.getFanoutHost().getTask(input.parentTaskId) : null;
    const shard = Array.isArray(task?.shards)
      ? task.shards.find((entry) => entry?.shardId === input.shardId)
      : undefined;
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    for (const attempt of attempts) {
      if (!Number.isSafeInteger(attempt?.attempt) || attempt.attempt >= input.attempt) continue;
      const childId = typeof attempt.childId === "string" ? attempt.childId : "";
      if (childId.length === 0) continue;
      const record = storage.readSnapshot().childModels?.[childId];
      if (record?.outputSchemaRequested === true) return true;
    }
    return false;
  }

  /** 该任务是否已有 schema 声明（幂等提交时保留最初声明）。 */
  function hasFanoutOutputSchemas(parentTaskId) {
    return fanoutOutputSchemas.has(parentTaskId);
  }

  return {
    normalizedFanoutRoute,
    cacheFanoutOutputSchemas,
    hasFanoutOutputSchemas,
    fanoutOutputSchemaFor,
    clearFanoutOutputSchemas,
    clearAllFanoutOutputSchemas,
    cacheFanoutRoute,
    fanoutRouteFor,
    clearFanoutRoute,
    clearAllFanoutRoutes,
    assertFanoutProviderRouteUnchanged,
    fanoutSchemaWasRequestedBefore,
  };
}

/**
 * fan-out 任务命令：提交、多轮续作、续作拒绝文案与父任务反馈文本。
 *
 * @param {object} deps - 窄能力面（5 组：core / models / runtime / waits / caches）。
 * @returns {object} fan-out 任务命令面。
 */
export function createFanoutTaskCommands({ core, models, runtime, waits, caches }) {
  const { normalizeOutputSchemaDeclaration, resolveSubagentProviderForRole, assertOutputSchemaProviderSupport } = core;
  const { resolveRole } = models;
  const { registerFanoutGoalHandoff, registerFanoutRetryGoalHandoff } = waits;
  const { normalizedFanoutRoute, cacheFanoutOutputSchemas, fanoutRouteFor, cacheFanoutRoute } = caches;
  /**
   * fan-out 提交入口：只调用 manager 并登记 root turn 等待工作。
   *
   * 改造后这里**不再暂停 durable goal**：任务在后台按自己的调度推进，root 的当前
   * turn 由 finalize 保持打开（见 host/turn-wait.js），因此「任务运行期间 root 不会
   * 抢跑」这一语义由等待登记表承担。
   *
   * @param {object} parent - exact live root Agent。
   * @param {object} args - fanout 工具的已校验入参（含 role）。
   * @param {object} [precheckRoute] - 提交前 resolveRoleModelRoute 的实际选择与 marker。
   * @returns {object} manager 的提交结果。
   */
  function submitFanoutTask(parent, args, precheckRoute) {
    /**
     * provider 归属（票据 26 背压）与提交前路由固化（票据 24 fallback）。
     *
     * 为什么在组合根解析而不是在 manager 里：provider 是「模型路由」的概念，
     * 权威来源是 resolveRole（会话覆盖优先、其次全局默认），但**真正的 provider**
     * 是提交前预检（primary -> 有序候选）实际选中的那个。manager 只该拿到一个稳定
     * 的归属字符串用于并发记账，不应自己会去读 settings/会话覆盖，也不应重新跑
     * fallback。
     *
     * precheckRoute 由 fanout 工具在提交前用同一套 executeModelRoutePlan 得到：
     * - 优先使用 route.selection.provider（fallback 后的实际 provider）；
     * - 仅在未传预检结果（兼容调用/测试）时回落到 resolveRole 的主选择。
     *
     * 解析不到选择（角色尚未配置模型）时**不传** provider：provider 限流对该任务
     * 不生效，但角色/任务级限流仍照常生效——绝不因为无法归属就拒绝提交。
     *
     * 提交返回后同步把预检路由写进有界映射：manager 的 drain 在 microtask 中执行，
     * 因此 buildRequest 一定能在任何 admission 之前看到它，不会二次 fallback。
     */
    const role = typeof args?.role === "string" ? args.role : "";
    // 结构化声明（票据 30）：逐分片在提交前校验；任一分片非法/超限或 provider 不支持
    // 都整体拒绝（不登记任务、不创建任何 child）。schema 原文只留在内存映射里。
    const declarations = new Map();
    for (const [index, shard] of (Array.isArray(args?.shards) ? args.shards : []).entries()) {
      const shardId = typeof shard?.shardId === "string" ? shard.shardId : String(index);
      const declaration = normalizeOutputSchemaDeclaration(shard?.outputSchema, "fanout 分片 " + shardId);
      if (declaration !== undefined) declarations.set(shardId, declaration.schema);
    }
    if (declarations.size > 0) {
      const target = resolveSubagentProviderForRole(role, parent);
      assertOutputSchemaProviderSupport(target.provider, "fanout " + role);
    }
    const route = normalizedFanoutRoute(precheckRoute);
    const selection = role.length > 0 && typeof parent?.id === "string" ? resolveRole(parent.id, role) : null;
    // 预检路由优先：fallback 后实际选中的 provider 才是名额归属，而不是 primary。
    const provider = route?.selection.provider
      ?? (typeof selection?.provider === "string" && selection.provider.trim().length > 0
        ? selection.provider.trim()
        : undefined);
    const result = runtime.getFanoutHost().submit(parent, provider === undefined ? args : { ...args, provider });
    if (declarations.size > 0 && typeof result?.parentTaskId === "string"
      && (result.duplicate !== true || !caches.hasFanoutOutputSchemas(result.parentTaskId))) {
      // 幂等命中的既有任务保留最初声明的 schema；只有进程内映射确实缺失（例如
      // 结算后重放同一 requestId）时才用本次声明补齐，避免重复提交改写既有契约。
      cacheFanoutOutputSchemas(result.parentTaskId, declarations);
    }
    /**
     * 路由映射写入必须**先于任何 await**：manager 在 submit 内只登记任务并把 drain
     * 排进 microtask，因此这里同步写入后，buildRequest 必然能看到同一份预检路由。
     *
     * 幂等命中的既有任务保留最初路由；只有映射确实缺失、且任务的实际 provider 与
     * 本次预检一致时才补齐，避免重复提交把旧任务改写到另一条 provider 路由上。
     */
    const parentTaskId = typeof result?.parentTaskId === "string" ? result.parentTaskId : "";
    if (route !== undefined && result?.accepted !== false && parentTaskId.length > 0) {
      const taskProvider = typeof result?.task?.provider === "string" ? result.task.provider : "";
      const existingRoute = fanoutRouteFor(parentTaskId);
      const providerMatches = taskProvider.length === 0 || taskProvider === route.selection.provider;
      if (existingRoute === undefined && providerMatches) cacheFanoutRoute(parentTaskId, route);
    }
    registerFanoutGoalHandoff(parent, result);
    return result;
  }

  /**
   * 构造 continuation 句柄（工具回执/模型可见的「下一次怎么调用」契约）。
   *
   * 必须完整、稳定、可照抄：parentTaskId/role/round、父级状态与是否可继续、每个分片的
   * shardId/childId/当前 attempt/attemptCount、以及下一次调用所需字段。主代理据此决定
   * 是否续作同一逻辑任务，不需要读源码猜用法。
   *
   * @param {object} task - manager 的只读任务快照。
   * @returns {object|undefined} continuation 句柄；非法输入返回 undefined。
   */
  function buildFanoutContinuationHandle(task) {
    if (task === null || typeof task !== "object") return undefined;
    const shards = Array.isArray(task.shards) ? task.shards : [];
    const round = Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1;
    // 父级聚合按用户确认规则：任一分片仍有未终态 attempt → running；全部结束 → ready。
    // manager 的 task.status 已经是最新 attempt 聚合（pending / completed / ...），
    // 这里只把它翻译成侧边栏与回执共用的 running|ready 词表。
    const running = task.status === "pending";
    const shardHandles = shards.map((shard) => {
      const attempts = Array.isArray(shard.attempts) ? shard.attempts : [];
      const latest = attempts[attempts.length - 1];
      const attempt = Number.isSafeInteger(latest?.attempt) ? latest.attempt : 0;
      return {
        shardId: shard.shardId,
        ...(typeof shard.name === "string" && shard.name.length > 0 ? { name: shard.name } : {}),
        childId: typeof latest?.childId === "string" ? latest.childId : null,
        attempt,
        attemptCount: attempts.length,
        status: shard.status ?? null,
        nextAttempt: attempt + 1,
      };
    });
    const nextAttemptByShard = {};
    for (const shard of shardHandles) nextAttemptByShard[shard.shardId] = shard.nextAttempt;
    return {
      parentTaskId: task.parentTaskId,
      role: task.role,
      round,
      status: task.status,
      running,
      // reusable：本轮 wait-all 已完成、任务未取消、manager 未关闭时才可以续作。
      reusable: task.continuable === true,
      shardIds: shardHandles.map((shard) => shard.shardId),
      shards: shardHandles,
      nextAttemptByShard,
      // 下一次调用所需字段：模型可直接照抄，只替换 prompt 文案。
      resumeWith: {
        tool: "fanout",
        arguments: {
          role: task.role,
          basePrompt: "<本轮共享目标>",
          shards: shardHandles.map((shard) => ({ shardId: shard.shardId, prompt: "<本轮该分片指令>" })),
          continuation: { parentTaskId: task.parentTaskId },
        },
      },
    };
  }

  /**
   * 多轮复用入口（fanout 工具的 continuation 参数）。
   *
   * 语义：
   * - 复用判定由主代理发起；插件校验 role / 分片数量 / shardId 结构一致、任务属于本 root、
   *   上一轮 wait-all 已完成，任一不满足即结构化拒绝（不改状态、不建 attempt）；
   * - 每个既有 shard 追加一个新 attempt，保留原 childId，旧 attempt 历史原样保留；
   * - 提交成功后任务立即回到 pending（投影 = running，侧边栏不再显示上一轮 stale ready），
   *   并**重新登记 root turn 等待工作**（新一轮运行期间 root 不会抢跑）。
   *
   * 失败一律抛带 code/reason 的错误：工具调用方（主代理）能直接读到拒绝原因，而 manager
   * 侧已经保证「校验先于任何状态修改」，因此不存在半写。
   *
   * @param {object} parent - 调用方 exact root Agent。
   * @param {{parentTaskId:string, role:string, basePrompt:string, shards:object[], requestId?:string}} args
   * @returns {object} 续作结果（含 manager 任务快照）。
   */
  function continueFanoutTask(parent, args) {
    const result = runtime.getFanoutHost().continueTask(parent, args);
    if (result?.accepted !== true) {
      const reason = typeof result?.reason === "string" && result.reason.length > 0
        ? result.reason
        : (typeof result?.code === "string" && result.code.length > 0 ? result.code : "continuation_rejected");
      const error = new Error(describeFanoutContinuationRejection(reason, result));
      error.name = "FanoutContinuationError";
      error.code = result?.code ?? "FANOUT_CONTINUATION_REJECTED";
      error.reason = reason;
      error.detail = result;
      throw error;
    }
    // 任务重新 pending：立刻重新登记等待工作（新代次），与 retry 同一语义。
    // 幂等重放（duplicate=true）不改变任何状态，因此绝不能重新登记——
    // 那会把一个已经结算的轮次又挂成等待项。
    if (result.duplicate !== true) {
      registerFanoutRetryGoalHandoff(parent, result.parentTaskId, result.task);
    }
    return result;
  }

  /** 续作拒绝的中文说明：每种拒绝都给出可操作的下一步，而不是只抛 reason 字面量。 */
  function describeFanoutContinuationRejection(reason, detail = {}) {
    switch (reason) {
      case "unknown_parent_task":
        return "fan-out continuation 被拒绝：parentTaskId 不存在（" + String(detail.parentTaskId) + "）";
      case "not_owned_by_root":
        return "fan-out continuation 被拒绝：parentTaskId 不属于当前 root 的当前代际（" + String(detail.parentTaskId)
          + "，ownership: " + String(detail.ownership ?? "unproven") + "）";
      case "task_reclaimed":
        return "fan-out continuation 被拒绝：父任务已被回收（" + String(detail.parentTaskId)
          + "）；同 requestId 重新提交会创建新任务，不会复用旧任务";
      case "reclaim_in_progress":
        return "fan-out continuation 被拒绝：另一个回收正在进行中，请稍后重试";
      case "not_live_root":
        return "fan-out continuation 被拒绝：调用方不是当前代际的 live root（root 已销毁或被同 id 新代际替换）";
      case "child_session_unavailable":
        return "fan-out continuation 被拒绝：分片既有 child 的会话不可解析（"
          + (Array.isArray(detail.shardIds) ? detail.shardIds.join(", ") : "") + "），请改用 fanout-retry-shard 或提交新任务";
      case "continue_route_unavailable":
        return "fan-out continuation 被拒绝：Host 未接线续作投递路由（continueMessage）";
      case "request_budget_exceeded":
        return "fan-out continuation 被拒绝：该父任务的续作 requestId 记录已达预算，请提交新的 fan-out 任务";
      case "role_mismatch":
        return "fan-out continuation 被拒绝：role 必须与原任务一致（期望 " + String(detail.expectedRole) + "，收到 " + String(detail.role) + "）";
      case "shard_count_mismatch":
        return "fan-out continuation 被拒绝：分片数量必须与原任务一致（期望 " + String(detail.expected) + "，收到 " + String(detail.received) + "）";
      case "shard_ids_mismatch":
        return "fan-out continuation 被拒绝：shardId 结构必须与原任务一致（缺少 " + String(detail.missing) + "）";
      case "task_not_ready":
        return "fan-out continuation 被拒绝：上一轮 wait-all 尚未完成（分片 " + String(detail.shardId) + " 仍是 " + String(detail.shardStatus) + "）";
      case "parent_cancelled":
        return "fan-out continuation 被拒绝：该父任务已被取消，请提交新的 fan-out 任务";
      case "attempt_budget_exceeded":
        return "fan-out continuation 被拒绝：分片 " + String(detail.shardId) + " 已耗尽 attempt 预算，请提交新的 fan-out 任务";
      case "duplicate_request_id":
        return "fan-out continuation 被拒绝：requestId 已用于另一个父任务的续作";
      case "missing_parent_task_id":
        return "fan-out continuation 被拒绝：continuation.parentTaskId 必须是非空字符串";
      case "manager_closed":
      case "runtime_closed":
        return "fan-out continuation 被拒绝：fan-out runtime 已关闭";
      default:
        return "fan-out continuation 被拒绝：" + reason;
    }
  }

  function buildFanoutFeedback(task) {
    const results = task.shards.map((shard) => {
      const attempt = shard.attempts[shard.attempts.length - 1] ?? {};
      return {
        shardId: shard.shardId,
        status: shard.status,
        attempt: attempt.attempt,
        ...(attempt.result === undefined ? {} : { result: attempt.result }),
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
      };
    });
    const payload = { parentTaskId: task.parentTaskId, role: task.role, status: task.status, counts: task.counts, results };
    let serialized;
    try { serialized = JSON.stringify(payload, null, 2); } catch {
      // 结果理论上已按 attempt 预算校验过；这里仍兜底，避免反馈构造自身抛异常。
      serialized = JSON.stringify({ parentTaskId: task.parentTaskId, status: task.status });
    }
    // 只按 UTF-8 字节预算截断；不能先按字符切掉 source，否则 receivedBytes 会失真，
    // 也会让中文/emoji 在两个预算之间产生不可见的丢失。truncateFeedbackText 会保留
    // 原始输入字节数，并在截断结果中附带可按 parentTaskId 查询完整快照的提示。
    const head = "Fan-out 父任务已完成（wait-all）：\n";
    const trimmed = truncateFeedbackText(
      { parentTaskId: task.parentTaskId, text: serialized },
      { maxBytes: FANOUT_BUDGET.maxFeedbackBytes - Buffer.byteLength(head, "utf8") },
    );
    // 截断/不可测量过去只取 .text，事实被丢弃；现在把同源 violation 补发为统一
    // budget_rejected(phase=feedback)。调用发生在 manager 的事件发布路径内，属于
    // 同一持久化批；事件只带资源名/字节/上限，不含反馈正文。
    if (trimmed.violation !== null && trimmed.violation !== undefined) {
      try {
        runtime.getFanoutHost()?.recordBudgetViolation?.(trimmed.violation, "feedback", { parentTaskId: task.parentTaskId });
      } catch {
        // 诊断失败不得影响父会话反馈注入。
      }
    }
    return head + trimmed.text;
  }

  return {
    buildFanoutFeedback,
    submitFanoutTask,
    buildFanoutContinuationHandle,
    continueFanoutTask,
    describeFanoutContinuationRejection,
  };
}

/**
 * fan-out 请求构造：一次 attempt 的 request（路由、persona、deny、schema 声明）。
 *
 * @param {object} deps - 窄能力面（6 组：identity / models / core / roles / storage / caches）。
 * @returns {object} buildRequest 能力。
 */
export function createFanoutRequestBuilder({ identity, models, core, roles, storage, caches }) {
  const { restoredFanoutModelRoute, resolveRoleModelRoute, routeMarkerOf, routeSnapshotMarkerOf } = models;
  const { resolveSubagentProviderForRole, resolvePersistedSubagentTarget, expertDenyForAdmission, markStructuredRequest } = core;
  const { resolvePersonaForAdmission } = storage;
  const { assertFanoutProviderRouteUnchanged, fanoutOutputSchemaFor, fanoutSchemaWasRequestedBefore, fanoutRouteFor } = caches;
  async function buildRequest(input, signal) {
      const parent = identity.parentAgentOf(input.parentTaskId);
      if (parent === void 0) throw new Error("fan-out parent root is unavailable: " + input.parentTaskId);
      // 启动前路由（票据 24 × 票据 03）：恢复产生的 interrupted attempt 只读 child_models
      // 里的实际路由；峰谷启用时则由 scheduler 在进入 running **之前**同步冻结快照
      // （launchInput.precomputedRoute）；其余普通新派发才执行 primary -> candidates 的 fallback。
      //
      // 优先级（逐级都不得越过前一层的决定）：
      // 1. restoredRoute：中断 attempt 的持久化实际路由（恢复不重选）；
      // 2. 冻结快照：派发时刻已写进 attempt.route 的那份计划（不重新选路、不重查目录）；
      // 3. 提交时的预检路由：同一 parentTaskId 的新 attempt/retry 复用提交时已确定的
      //    实际 provider，避免第二次 fallback 选到另一个 provider、把名额记错；
      // 4. 冷恢复/旧任务/峰谷未启用：只能重新解析（随后必须通过 provider 一致性校验）。
      const restoredRoute = restoredFanoutModelRoute(input);
      // 冻结快照非法即抛稳定错误（fail-closed），绝不当成缺失继续重选。
      const frozenRoute = frozenFanoutRouteOf(input);
      const cachedRoute = restoredRoute === null && frozenRoute === undefined
        ? fanoutRouteFor(input.parentTaskId)
        : undefined;
      const cachedRouteInput = cachedRoute === undefined
        ? undefined
        : { selection: { ...cachedRoute.selection }, ...cachedRoute.marker };
      const route = restoredRoute ?? frozenRoute?.route ?? cachedRouteInput
        ?? await resolveRoleModelRoute(input.role, parent.id, signal);
      if (route === null) throw new Error(input.role + " 专家尚未配置模型");
      /**
       * provider 一致性校验的边界（票据 03）：冻结快照**不走**这条校验。
       *
       * 原因：任务级 provider 归属是提交时固化的单个值，而峰谷启用后同一任务的相邻分片
       * 可能落在不同时段、因而使用不同 provider（正是本票据「逐 shard 冻结」要表达的
       * 事实）。若沿用旧校验，跨边界的那一片会被判成「路由变化」而拒绝启动——那是把
       * ticket 05 的「attempt 级 provider 归属」缺口误报成配置错误。enabled 路径下名额
       * 归属的修正属于票据 05，这里先跳过、保留旧路径（未冻结）的 fail-closed 行为。
       */
      if (frozenRoute === undefined) assertFanoutProviderRouteUnchanged(input.parentTaskId, route);
      const validatedSelection = route.selection;
      // 完整快照 marker（票据 03）：冻结路径必然有；其余路径只有峰谷启用时才有
      // （resolveRoleModelRoute 返回的 route 自带 snapshot），未启用峰谷时 undefined，
      // 因此旧路径的 agentOptions 形状逐字不变。
      const routeSnapshotMarker = routeSnapshotMarkerOf(route);
      // 目标 subagent provider（票据 29）：新 attempt 按当前角色设置选择；恢复出来的
      // interrupted attempt 只读上一 child 的快照，绝不按当前设置重选。Observer 无论
      // 设置如何都强制非继承通道；继承型失败绝不静默回退 spawn。
      const subagentTarget = restoredRoute === null
        ? resolveSubagentProviderForRole(input.role, parent)
        : resolvePersistedSubagentTarget(input.role, parent, restoredRoute);
      // deny 边界来自内置角色目录：只读角色沿用 READONLY_DENY，
      // 可写角色叠加委派与 root-only 拒绝。
      const deny = expertDenyForAdmission(parent, roles.require(input.role));
      // 分片任务名称是展示层短标签：有名称时子代理的 dispatch label 与任务正文都
      // 显示"分片代号 + 任务名称"，让专家自己知道这一片在整体目标里叫什么；没有名称
      // 时保持旧文案（只有分片代号与 attempt 序号）。
      // manager 已把名称归一化（非空 + 已 trim）；这里再 trim 一次只是防御运行期
      // 二次装配带来的差异，语义与校验侧完全一致。
      const shardName = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : undefined;
      const taskText = [
        input.basePrompt,
        "",
        "当前分片（shardId: " + input.shardId + ", attempt: " + input.attempt + "）：",
        ...(shardName === undefined ? [] : ["任务名称：" + shardName]),
        input.prompt,
      ].join("\n");
      // 分片任务同样在 admission 边界解析当前权威 persona：设置页保存后，
      // 之后新建的 fan-out child 使用新覆盖，正在运行的分片不受影响。
      // 同一份值写入内部 marker，由 onAgentCreated 随 child_models 持久化，
      // 供冷恢复的 composition 兜底使用（不会进入任务 prompt）。
      const childPersona = resolvePersonaForAdmission(input.role);
      // 结构化声明（票据 30）：本次 attempt 的 schema 只来自 Host 侧有界映射；
      // 映射缺失（冷恢复/任务已结算后重试）时不重新声明，但历史确实声明过时把本轮
      // 标记为 schema_not_restored（child_models 只写 fallback 标记）。
      const outputSchema = fanoutOutputSchemaFor(input.parentTaskId, input.shardId);
      const schemaNotRestored = outputSchema === undefined && fanoutSchemaWasRequestedBefore(input);
      const request = {
        label: "fan-out " + input.role + "/" + input.shardId + (shardName === undefined ? "" : " · " + shardName) + " #" + input.attempt,
        prompt: [{ type: "text", text: buildExpertTaskPrompt(input.role, taskText) }],
        parent,
        // 内部字段：只供 startExpertActivation 选择宿主 provider，调用宿主前剥离。
        subagentProvider: subagentTarget.provider,
        agentOptions: {
          provider: validatedSelection.provider,
          model: validatedSelection.model,
          [EFFORT_MARKER]: validatedSelection.reasoningEffort,
          // 目标 subagent provider / 继承开关 marker（票据 29）：随 child_models 落盘。
          [EXPERT_SUBAGENT_PROVIDER_MARKER]: subagentTarget.provider,
          [EXPERT_INHERIT_CONTEXT_MARKER]: subagentTarget.inheritContext,
          // 实际路由（票据 24）：分片 child 的 candidateIndex/fallbackCount/
          // lastRouteErrorCode 随 child_models 落盘，投影与恢复只读该快照。
          [EXPERT_ROUTE_MARKER]: routeMarkerOf(route),
          // 派发路由冻结快照（票据 03）：与 attempt.route 同一份数据，随 child_models 落盘。
          // 未启用峰谷时 route 没有 snapshot，marker 保持缺省——旧快照形状不变。
          ...(routeSnapshotMarker === undefined
            ? {}
            : { [EXPERT_ROUTE_SNAPSHOT_MARKER]: routeSnapshotMarker }),
          [ROLE_MARKER]: input.role,
          [PARENT_MARKER]: parent.id,
          [CONTINUABLE_MARKER]: true,
          // RC1 把 request.toolFilter 应用到 child composition；这里同步保留 fan-out
          // admission 的完整 deny 结果，供冷恢复的 scoped guard 使用。
          [DENY_MARKER]: ensureExpertSendMessageDenied(deny),
          [PERSONA_MARKER]: childPersona,
          [FANOUT_MARKER]: true,
          [FANOUT_PARENT_TASK_MARKER]: input.parentTaskId,
          [FANOUT_PARENT_AGENT_MARKER]: parent.id,
          [FANOUT_SHARD_MARKER]: input.shardId,
          [FANOUT_ATTEMPT_MARKER]: input.attempt,
          ...(outputSchema === undefined && schemaNotRestored !== true
            ? {}
            : { [OUTPUT_SCHEMA_REQUESTED_MARKER]: true }),
        },
        persona: childPersona,
        toolFilter: { deny: ensureExpertSendMessageDenied(deny) },
        maxDepth: 1,
        // schema 原文只进入宿主请求；恢复轮没有 schema，只有“曾声明过”的标记。
        ...(outputSchema === undefined ? {} : { outputSchema }),
      };
      if (outputSchema !== undefined) {
        markStructuredRequest(request, { requested: true, notRestored: false });
      } else if (schemaNotRestored === true) {
        markStructuredRequest(request, { requested: true, notRestored: true });
      }
      return { request, parentAgent: parent, parentId: parent.id, role: input.role, route: routeMarkerOf(route) };
  }

  return { buildRequest };
}

/**
 * fan-out child 创建回调：exact Agent 登记、scoped guard/effort/route 安装与 child_models 落盘。
 *
 * @param {object} deps - 窄能力面（6 组：childSurface / storage / core / roles / recovery）。
 * @returns {object} onAgentCreated 能力。
 */
export function createFanoutChildHandlers({ childSurface, storage, core, roles, recovery }) {
  const { validSubagentProviderName, flushPendingStructuredPatch } = core;
  function onAgentCreated({ agent, role, parentId, parentTaskId, parentAgentId, shardId, attempt }) {
    registerPluginExpertChildAgent(agent);
    childSurface.installExpertReportGuardForAgent(agent, { role, parentId, source: "fanout" });
    childSurface.installEffortInjection(agent, childSurface.resolveEffortOf(agent));
    // fan-out 分片 child 同样安装运行期 route 覆盖：分片是独立 child，降级只在
    // 该分片自己会话内生效，不会影响其它分片或父任务的重试预算。
    childSurface.installModelFallbackRouteOverride(agent);
    if (typeof agent?.id === "string") recovery.noteChildActivation(agent.id, agent);
    const childId = typeof agent?.id === "string" ? agent.id : void 0;
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    const fanoutIdentity = typeof parentTaskId === "string"
      && parentTaskId.length > 0
      && typeof shardId === "string"
      && shardId.length > 0
      && Number.isSafeInteger(attempt)
      && attempt > 0;
    if (childId !== void 0 && typeof provider === "string" && typeof model === "string") {
      // persona 与 deny 同源：fan-out 走独立 onAgentCreated 回调，这里同步保存
      // admission 快照，冷恢复的 composition 兜底据此重建角色人格；malformed 值
      // 不写入 durable schema（真实 storage-domain 会在写入边界整条拒绝）。
      const personaSnapshot = validPersonaMarker(agent.options?.[PERSONA_MARKER]);
      // 实际路由 marker（票据 24）：由 buildRequest 在启动前 fallback 后写入。
      const routeSnapshot = normalizeModelRouteMarker(agent.options?.[EXPERT_ROUTE_MARKER]);
      // 目标 subagent provider / 继承开关（票据 29）：marker 优先；cold-resume 的
      // agent options 不还原 marker，回落到 DEG 自有 child_models 记录。
      const persistedFanoutChild = typeof childId === "string" ? storage.readSnapshot().childModels?.[childId] : void 0;
      /**
       * 派发路由冻结快照（票据 03）：marker 优先，cold-resume 回落到已持久化记录。
       *
       * 为什么必须在这里也写一次：本回调用的是**整条** writeChildModel，会把
       * agent/created marker 监听器刚写下的 route 覆盖掉；不带回来快照就会在 fan-out
       * child 上丢失（role 工具走的是 patch 写入，不受影响）。
       */
      const dispatchRouteSnapshot = fanoutRouteSnapshotRecordOf(agent.options, persistedFanoutChild);
      const subagentProviderSnapshot = validSubagentProviderName(agent.options?.[EXPERT_SUBAGENT_PROVIDER_MARKER])
        ?? validSubagentProviderName(persistedFanoutChild?.subagentProvider);
      const inheritContextSnapshot = typeof agent.options?.[EXPERT_INHERIT_CONTEXT_MARKER] === "boolean"
        ? agent.options[EXPERT_INHERIT_CONTEXT_MARKER]
        : (typeof persistedFanoutChild?.inheritContext === "boolean" ? persistedFanoutChild.inheritContext : void 0);
      void storage.writeChildModel(childId, {
        provider,
        model,
        ...(typeof agent.options?.[EFFORT_MARKER] === "string" ? { reasoningEffort: agent.options[EFFORT_MARKER] } : {}),
        ...(routeSnapshot === undefined ? {} : routeSnapshot),
        // 完整冻结快照（票据 03）：与 agentOptions marker / attempt.route 同源。
        ...(dispatchRouteSnapshot === undefined ? {} : { route: dispatchRouteSnapshot }),
        ...(subagentProviderSnapshot === void 0 ? {} : { subagentProvider: subagentProviderSnapshot }),
        ...(inheritContextSnapshot === void 0 ? {} : { inheritContext: inheritContextSnapshot }),
        // 结构化交付（票据 30）：只保留布尔与已捕获结果；schema 原文绝不落盘。
        ...(agent.options?.[OUTPUT_SCHEMA_REQUESTED_MARKER] === true
          || persistedFanoutChild?.outputSchemaRequested === true
          ? { outputSchemaRequested: true }
          : {}),
        ...(persistedFanoutChild?.structured === undefined ? {} : { structured: persistedFanoutChild.structured }),
        ...(typeof role === "string" ? { role } : {}),
        // 角色显示名快照：历史分片在角色不再可用时仍能显示标签。
        ...(typeof role === "string" && typeof roles.roleLabelOfRole(role) === "string" ? { roleLabel: roles.roleLabelOfRole(role) } : {}),
        ...(typeof parentId === "string" ? { parentId } : {}),
        continuable: true,
        // fan-out 走独立 onAgentCreated 回调；这里同步保存 RC1 admission deny 快照。
        ...(Array.isArray(agent.options?.[DENY_MARKER])
          ? { [DENY_MARKER]: [...agent.options[DENY_MARKER]] }
          : {}),
        ...(personaSnapshot === void 0 ? {} : { [PERSONA_MARKER]: personaSnapshot }),
        // shadow 生效性判定快照：fan-out child 的 composition 也走同一条安装路径，
        // 判定结果在 onAgentCreated 之前已记录（foreign 时 child 根本不会被创建）。
        ...shadowMarkerFields(childId),
        ...(fanoutIdentity ? {
          fanout: true,
          fanoutParentTaskId: parentTaskId,
          fanoutParentAgentId: typeof parentAgentId === "string" ? parentAgentId : parentId,
          fanoutShardId: shardId,
          fanoutAttempt: attempt,
        } : {}),
      }).then(() => flushPendingStructuredPatch(childId));
    }
  }

  return { onAgentCreated };
}

/**
 * fan-out 运行期 seam：manager 需要的六个回调（请求构造、启动、续作、中断、child 创建、事件）。
 *
 * @param {object} deps - 窄能力面（6 组：identity / childIo / core / waits / requestBuilder / childHandlers）。
 * @returns {object} runtime seam 能力面。
 */
export function createFanoutToolHooks({ identity, childIo, core, waits, requestBuilder, childHandlers, dispatch }) {
  const { startExpertActivation } = core;
  const { handleFanoutLifecycleEvent } = waits;
  const { buildRequest } = requestBuilder;
  const { onAgentCreated } = childHandlers;
  // 派发期路由冻结所需的两个只读取值函数（票据 03）：同一代读的设置快照 + 只读时钟。
  // 缺失时（测试替身/旧装配）冻结 seam 返回 null，manager 保持旧路径。
  const readSettingsSnapshot = typeof dispatch?.readSettingsSnapshot === "function"
    ? dispatch.readSettingsSnapshot
    : undefined;
  const dispatchClock = dispatch?.clock;

  /**
   * 派发前路由决定 seam（票据 03 冻结 / 票据 04 复用）：scheduler 在 attempt 进入
   * running 之前同步调用。
   *
   * 为什么要在这里合成而不是让 scheduler 读 settings：scheduler 属于 fanout/ 域，不得
   * 直连宿主设置；组合根只交出**取值函数**，sessionId（会话覆盖的键）由本域从父任务
   * 归属解析。
   *
   * 为什么交出函数而不是已读好的值（票据 04）：恢复回来的 queued attempt 与多轮续作
   * 只读 attempt 记录的冻结快照，**根本不应读设置**。把读取推迟到真正需要重新冻结的
   * 那一层，才能让「没有重新冻结 ⇒ 没有设置读」成为结构事实，而不是依靠调用顺序的约定。
   *
   * @param {object} input - { task, shard, attempt, round, continuation }。
   * @returns {null|{ok:false, code:string}|{ok:true, snapshot:object, selection:object}}
   */
  function prepareAttempt(input) {
    const parentAgentId = identity.parentAgentOf(input?.task?.parentTaskId)?.id;
    return prepareFanoutAttempt({
      ...input,
      sessionId: typeof parentAgentId === "string" ? parentAgentId : undefined,
      ...(typeof readSettingsSnapshot === "function" ? { readSettingsSnapshot } : {}),
      clock: dispatchClock,
    });
  }

  function startContinuable({ request, signal }) {
    return startExpertActivation({ request, label: request.label, signal });
  }

  /**
   * 多轮复用：把本轮 prompt 投递给**同一 child**（不新建 child、不新建父任务）。
   *
   * 走既有公开 continuation seam（sendMessageToExistingChild → subagents.sendMessage）：
   * lineage/root generation 校验、message admission 与 disposal 都由 Host 负责；插件
   * 不直接操作 child 内部状态。本轮正文与首轮 buildRequest 同构（basePrompt + 分片标识 +
   * 本轮 prompt，并显式标注 round/attempt），persona 已绑定在该 child 上、无需重复注入。
   * 返回的新 messageId 会被 runtime 记为「本轮应该结算的 turn」，用于拒绝上一轮迟到
   * turn/end 覆盖新一轮 attempt。
   */
  function continueMessage({ childId, parentAgent, input, signal }) {
    if (parentAgent === void 0) throw new Error("fan-out continuation parent root is unavailable: " + childId);
    const shardName = typeof input?.name === "string" && input.name.trim().length > 0 ? input.name.trim() : undefined;
    const taskText = [
      typeof input?.basePrompt === "string" ? input.basePrompt : "",
      "",
      "当前分片续作（shardId: " + input?.shardId + ", attempt: " + input?.attempt
        + (Number.isSafeInteger(input?.round) ? ", round: " + input.round : "") + "）：",
      ...(shardName === undefined ? [] : ["任务名称：" + shardName]),
      typeof input?.prompt === "string" ? input.prompt : "",
    ].join("\n");
    return childIo.sendMessageToExistingChild({
      parent: parentAgent,
      childId,
      content: [{ type: "text", text: buildExpertTaskPrompt(input?.role, taskText) }],
      signal,
      interrupt: false,
      rootToken: identity.tokenFor(parentAgent),
    });
  }

  /**
   * 解析既有 child 的 session：多轮复用需要把本轮 attempt 绑定到上一轮同一个 child 的
   * session，才能由它的 turn/end 结算本轮。cold-resume 后 session 实例可能已更换，
   * 因此每次按 id 现读；拿不到时 runtime 会 fail-closed 本轮 attempt。
   */
  function resolveChildSession(childId) {
    return identity.getAgent(childId)?.session;
  }

  function interrupt({ childId, parentAgent }) {
    // DSH interrupt 需要 exact parent authority；活动 attempt 在 admission 时已经
    // 保存 parentAgent，缺失时只等待 child dispose/turn-end 自然收敛。
    if (parentAgent === void 0) return;
    return childIo.interrupt(childId, parentAgent);
  }

  return {
    onFanoutEvent: (event) => handleFanoutLifecycleEvent(event),
    buildRequest,
    startContinuable,
    continueMessage,
    resolveChildSession,
    interrupt,
    onAgentCreated,
    // 派发前路由冻结（票据 03）：manager 的 deps.prepareAttempt。缺失/返回 null 时
    // scheduler 走旧路径（异步 buildRequest 里重新选路）。
    prepareAttempt,
  };
}

/**
 * fan-out runtime 装配：`createFanoutRuntimeModule` 的 options + 生命周期回调。
 *
 * 注意：`ctx.effect` 的卸载注册与 `consumeFanoutRestore` 调用仍留在 `index.js`；
 * 本工厂只交出 `{ host, close }`，由入口在原注册点接线（铁律 1/2）。
 *
 * @param {object} deps - 窄能力面（8 组：identity / roles / storage / waits / caches / hooks / commands / logger）。
 * @returns {{host: object, close: Function}} runtime 句柄与关闭命令。
 */
export function createFanoutRuntimeWiring({ identity, roles, storage, waits, caches, hooks, commands, logger }) {
  const { lineage, getAgent, storageGeneration } = identity;
  const { activeRoles, roleCatalog } = roles;
  const settingsSource = () => storage.readSettingsSource();
  const { settleAllFanoutShardWaits, releaseFanoutGoalHandoff } = waits;
  const { clearFanoutOutputSchemas, clearFanoutRoute, clearAllFanoutOutputSchemas, clearAllFanoutRoutes } = caches;
  const { buildFanoutFeedback } = commands;
  const { onFanoutEvent, buildRequest, startContinuable, continueMessage, resolveChildSession, interrupt, onAgentCreated, prepareAttempt } = hooks;

  /**
   * fan-out 父任务真实终态时的等待结算入口。
   *
   * 任务整体 settle（completed / completed_with_errors / cancelled）时按**当前登记
   * 代次**结算 "fanout:<parentTaskId>:<attempt>" 工作项。回调是在 manager 的状态写入
   * 路径里同步触发的，因此这里只做同步的精确结算（登记表内部会按需重新判定静止）。
   *
   * exact Agent 优先用 fanout-runtime 在释放 lineage 绑定前捕获的对象：登记记录的
   * 归属校验是对象身份，按 id 重新解析可能拿到 replacement 代际。只有 exact 对象
   * 不可用时才退回 id，交由对象身份校验 fail-closed。
   */
  function onParentSettled(parentTaskId, parentAgent, parentAgentId) {
    // 结构化声明（票据 30）：只有已取消任务（不存在 retry 路径）在真实终态清理；
    // 完成/部分失败的任务保留有界 schema 映射，供同一进程内的手工 retry 复用。
    let terminalTask;
    try { terminalTask = host?.getTask?.(parentTaskId); } catch { terminalTask = null; }
    if (terminalTask?.parentCancelRequested === true) {
      clearFanoutOutputSchemas(parentTaskId);
      clearFanoutRoute(parentTaskId);
    }
    // per-shard 排队工作兜底结算（票据 26）：task_settled 事件路径通常已经结算过，
    // 这里是「任务真实终态」的权威边界，负责清掉任何残留镜像（例如关闭路径或
    // 事件丢失），确保 root 不会因为一个永远等不到的 shard 事件而悬挂。
    settleAllFanoutShardWaits(parentTaskId);
    if (waits.isStopping()) return;
    const agent = parentAgent ?? (typeof parentAgentId === "string" ? getAgent(parentAgentId) : void 0);
    if (agent === void 0) return;
    releaseFanoutGoalHandoff(agent, parentTaskId);
  }

  /**
   * fan-out 反馈注入（父任务可见的生产者自有消息来源）。
   *
   * 会话格式 V4 在写入边界**精确拒绝** `kind: "plugin"`（旧插件包装语法）：
   * `agent/inbox/spliced` 是受校验的事件类型之一，因此沿用旧写法会让父任务
   * 完全收不到反馈（或写入直接抛错）。
   *
   * 0.1.7 对「未知插件」的规范 kind 由 `producerKind()` 机械派生为
   * `plugin:<plugin>`（已知第一方插件才按改名表/同名表映射）；V4 只拒绝精确的
   * `"plugin"`，`plugin:` 前缀形式不受影响，客户端对未识别 kind 走 default
   * 分支——消息仍正常可见，只是不归属特定身份语气，语义安全。
   *
   * 因此这里使用生产者自有 kind `plugin:dsh-expert-group`，并**不再携带** `plugin`
   * 字段（V4 的生产者自有 source 只有 kind，旧字段在转换时会被丢弃）。
   * 这里刻意**不**套用任何第一方 kind：DEG 是外部插件，冒用 `subagent-*` 之类的
   * 第一方身份会让客户端把反馈误归属到 DSH 自身机制上。
   */
  function injectFeedback(parent, text) {
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: PRODUCER_SOURCE_KIND },
    });
    parent.inject(message);
  }

  const host = createFanoutRuntimeModule({
    createRuntime: (options) => createFanoutRuntime(options),
    runtimeOptions: {
      // affectedPaths 冲突只对可写内置角色（designer/fixer）生效；组合根这里按
      // 装配时刻的角色目录计算，角色集合固定为内置六角色。
      writeRoles: activeRoles().filter((role) => {
        const entry = roleCatalog().get(role);
        return entry !== void 0 && entry.readOnly !== true;
      }),
    },
    // 角色级并发上限：唯一权威来源是插件 settings.roleConcurrencyLimit；传解析函数
    // 而不是快照值，保证设置保存后新建任务立即按新值调度。
    concurrencyLimit: () => normalizeRoleConcurrencyLimit(settingsSource()?.roleConcurrencyLimit),
    // 逐角色并发覆盖（内置角色集）：与上面的默认值是两层关系，manager 派发时实时解析。
    roleLimits: () => settingsSource()?.roleLimits,
    // provider 级并发上限映射：只约束真正进入 running 的分片数（信号量语义）。
    providerLimits: () => settingsSource()?.providerLimits,
    // 角色级默认超时：每个新 attempt 解析一次；0 = 不启用。
    roleTimeoutMs: () => normalizeRoleTimeoutMs(settingsSource()?.roleTimeoutMs),
    onFanoutEvent,
    buildRequest,
    startContinuable,
    continueMessage,
    resolveChildSession,
    interrupt,
    onAgentCreated,
    // 派发前路由冻结（票据 03）：缺失时 manager 完全保持旧行为（异步 buildRequest 选路）。
    ...(typeof prepareAttempt === "function" ? { prepareAttempt } : {}),
    lineage,
    getAgent,
    buildFeedback: buildFanoutFeedback,
    onParentSettled,
    injectFeedback,
    writeSnapshot: (snapshot) => storage.persistFanoutSnapshot(snapshot),
    getPersistenceGeneration: () => storageGeneration(),
    readSnapshot: () => storage.readFanoutSnapshot(),
    persistenceHealth: storage.persistenceHealth,
    logger,
  });

  /** 插件卸载/关闭：先清 Host 侧声明映射，再关闭 runtime。 */
  function close() {
    clearAllFanoutOutputSchemas();
    clearAllFanoutRoutes();
    host?.close();
  }

  return { host, close };
}
