/**
 * fan-out 派发路由冻结与**复用**（票据 03 冻结 / 票据 04 恢复与续作，**同步**）。
 *
 * ## 为什么单独成模块
 * scheduler 必须在把 attempt 推进到 running **之前**决定「这一轮按什么顺序试哪些模型」，
 * 而 buildRequest 是异步的（要等宿主模型目录/预检）。如果把选路留在 buildRequest，就会出现
 * 「attempt 已经是 running，却还没有路由快照」的窗口：设置在这期间被改写、或时钟跨过峰谷
 * 边界，都会让同一次执行用上另一套配置。因此这里把「冻结」与「执行」拆开：冻结在派发前
 * 同步完成并写进 attempt 记录，执行仍在 buildRequest 与运行期降级里。
 *
 * ## 职责（三件，全部无状态）
 * 1. {@link prepareFanoutAttempt}：派发前同步决定本次 attempt 的路由（**复用优先、冻结兜底**，
 *    见下）；峰谷未启用且没有任何可复用/可冻结计划时返回 null（调用方逐字保持旧路径）；
 * 2. {@link frozenFanoutRouteOf}：把 launchInput 上的 precomputedRoute 严格校验成 buildRequest
 *    可直接消费的路由对象（非法即 fail-closed，绝不按当前配置重选）；
 * 3. {@link fanoutRouteSnapshotRecordOf}：从 agentOptions marker / 已持久化记录读出同一份
 *    快照，供 child_models 落盘。fan-out 的 child_models 写入是**整条**写入，会覆盖
 *    agent/created marker 监听器刚写的 route，因此这里必须显式带回，否则快照会丢。
 *
 * ## 复用优先级（票据 04：恢复与续作只读冻结快照）
 * 「派发那一刻」是唯一允许判定时段与选路的时刻。因此入口按下面的顺序短路，
 * **前一层成立就绝不进入下一层**：
 * 1. attempt 自身已带快照（恢复回来的 queued attempt，或续作时已复制）→ 直接复用；
 * 2. 多轮续作（attempt.continuation === true，或调用方显式声明 continuation）→ 从同一
 *    shard **最近一次带快照的 attempt** 克隆（不取父任务、不取兄弟分片）；
 * 3. 显式 retry（retryShard 新建的 attempt，没有 continuation 标记）与首次派发 → 按
 *    **新**派发时刻重新冻结。
 *
 * 前两层不取时钟、不读设置：它们的输入只有 attempt 记录本身。只有第三层才读取
 * settingsSnapshot 与 clock.now()，并且只取一次。
 *
 * 设置快照与时钟由调用方传入，本模块不读 settings、不取时间。
 *
 * @module dsh-expert-group/host/fanout-dispatch-route
 */
import { buildPeakValleyDispatchRoute } from "./peak-valley-route.js";
import { EXPERT_ROUTE_SNAPSHOT_MARKER } from "../shared/model-route.js";
import {
  ROUTE_SNAPSHOT_INVALID,
  normalizeRouteSnapshot,
  routeSnapshotActiveSelection,
} from "../shared/route-snapshot.js";

/** 冻结入口/读回遇到非法快照时抛出的稳定错误名（调用方按 code 分支，不解析文案）。 */
const ROUTE_SNAPSHOT_ERROR_NAME = "RouteSnapshotInvalidError";

/** 构造带稳定 code 的快照错误（每次新建，调用方可安全携带）。 */
function routeSnapshotError(code, reason) {
  const error = new Error("fan-out 派发路由快照非法，已拒绝启动 child");
  error.name = ROUTE_SNAPSHOT_ERROR_NAME;
  error.code = code;
  error.reason = reason;
  return error;
}

/**
 * 把一份**存在**的快照严格校验成可复用结果（票据 04）。
 *
 * 「缺失」与「非法」是两种不同事实：缺失（旧快照/未启用峰谷）才允许调用方回旧路径；
 * 存在但非法必须 fail-closed——绝不当成缺失后按当前 settings/时钟重选，那正是本票据
 * 要消除的重建面。reusedFromAttempt 只用于诊断，说明这份决定来自哪个 attempt。
 *
 * @param {unknown} rawRoute - attempt.route 的原始值。
 * @param {number|undefined} fromAttempt - 该快照所属 attempt 序号（诊断用）。
 * @returns {{ok:true, snapshot:object, selection:object, reused:true, reusedFromAttempt:number|undefined}
 *   |{ok:false, code:string, reason:string, invalidFromAttempt:number|undefined}}
 */
function reusableRouteResult(rawRoute, fromAttempt) {
  const normalized = normalizeRouteSnapshot(rawRoute);
  if (normalized.ok !== true) {
    return { ok: false, code: normalized.code, reason: normalized.reason, invalidFromAttempt: fromAttempt };
  }
  const { snapshot } = normalized;
  const selection = routeSnapshotActiveSelection(snapshot);
  // 防御性不变量：合法快照的活动候选必须存在，否则下游 provider/model 会变成 undefined。
  if (selection === undefined) {
    return { ok: false, code: ROUTE_SNAPSHOT_INVALID, reason: "active_selection_missing", invalidFromAttempt: fromAttempt };
  }
  return { ok: true, snapshot, selection, reused: true, reusedFromAttempt: fromAttempt };
}

/**
 * 同一 shard 内「更早、且最近一次带快照」的 attempt（票据 04 续作克隆源）。
 *
 * 只读**同一分片**更早的 attempt：父任务级别或兄弟分片的快照都不构成续作的依据——
 * 不同分片可能落在不同时段、使用不同 provider，跨分片复制会把名额归属记到别人名下。
 * 当前 attempt 通过对象身份定位；定位不到时退化为「扫描全部更早序号」的保守做法。
 *
 * @param {object} shard - manager 的分片记录（含 attempts）。
 * @param {object} attempt - 当前 queued attempt。
 * @returns {object|undefined} 带快照的更早 attempt。
 */
function previousAttemptWithRoute(shard, attempt) {
  const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
  const index = attempts.indexOf(attempt);
  const end = index === -1 ? attempts.length : index;
  for (let cursor = end - 1; cursor >= 0; cursor -= 1) {
    const entry = attempts[cursor];
    if (entry?.route !== void 0) return entry;
  }
  return undefined;
}

/**
 * 设置快照的**惰性**读取（票据 04）。
 *
 * 复用/续作路径绝不能读设置：调用方交出的是取值函数而不是已读好的值，因此「没有重新
 * 冻结」就不会发生任何设置读。只有第三层（显式 retry / 首次派发）才会调用它。
 * 读取失败**不吞掉**：调用方（scheduler）会把异常收成该 attempt 的受控失败。
 *
 * @param {object} input - prepareFanoutAttempt 的输入。
 * @returns {object|undefined} 同一代读的设置快照。
 */
function settingsSnapshotOf(input) {
  if (typeof input?.readSettingsSnapshot === "function") return input.readSettingsSnapshot();
  return input?.settingsSnapshot;
}

/**
 * 派发前的路由准备（scheduler.startShard 的同步 seam，票据 03/04）。
 *
 * 输入与输出语义：
 * - null：本次派发**没有**路由决定——峰谷未启用且没有任何可复用的冻结快照、两层都没有
 *   该角色主模型、或这是续作但同 shard 更早的 attempt 也没有快照。调用方必须保持旧的
 *   异步 buildRequest 路径与 provider 预检；
 * - {ok:false, code}：启用峰谷但配置非法（invalidCode / 快照构造失败），或**存在但非法**
 *   的复用快照——调用方必须让该 attempt 直接终态失败（queued→failed），**不得**先置
 *   running、不得占名额，也不得降级成普通配置或重新选路；
 * - {ok:true, snapshot, selection, reused?, reusedFromAttempt?}：决定成功；snapshot 是
 *   纯数据（可序列化），selection 是活动层当前候选（复用）或第 0 项（冻结）。
 *
 * @param {object} input - { task, shard, attempt, round, continuation, settingsSnapshot?,
 *   readSettingsSnapshot?, clock, sessionId }。sessionId 是发起派发的 root 会话 id
 *   （会话覆盖以此为准）；readSettingsSnapshot 优先于 settingsSnapshot。
 * @returns {null|{ok:false, code:string, reason?:string}
 *   |{ok:true, snapshot:object, selection:object, reused?:boolean, reusedFromAttempt?:number}}
 */
export function prepareFanoutAttempt(input) {
  const { task, shard, attempt, continuation } = input ?? {};
  // 只有「还没开始的 attempt」才在派发前决定路由：running/终态一律不重写。
  if (attempt === null || typeof attempt !== "object" || attempt.status !== "queued") return null;
  /**
   * ① 恢复回来的 queued attempt 已经带着派发时冻结的快照 → 直接复用。
   *
   * 这条分支必须排在时钟/设置读取之前：恢复那一刻的墙钟与设置与「派发那一刻」无关，
   * 读它们本身就是缺陷（哪怕读了不用，也会给将来的重构留下重选的口子）。
   */
  if (attempt.route !== void 0) return reusableRouteResult(attempt.route, attempt.attempt);
  /**
   * ② 多轮续作：复用上一轮的计划，不重新判时段。
   *
   * 续作投递的是**同一个 child**，模型由 child 自己保持；这里的快照只决定「这次执行的
   * 归属与降级顺序」。因此它必须与上一轮一致——峰谷此刻是否启用、现在是峰还是谷，
   * 都不构成改变同一逻辑任务路由的理由。
   */
  if (continuation === true || attempt.continuation === true) {
    const previous = previousAttemptWithRoute(shard, attempt);
    // 上一轮也没有冻结快照（峰谷当时未启用 / 旧快照缺字段）：保持旧路径。
    // 这里既不取时钟也不读设置，因此绝不会「按续作时刻重选时段」。
    if (previous === undefined) return null;
    return reusableRouteResult(previous.route, previous.attempt);
  }
  /**
   * ③ 显式 retry（retryShard 新建、既无快照也无 continuation 标记的 attempt）与首次派发：
   * 按**新**派发时刻重新冻结。
   *
   * 这是唯一允许重新判时段的入口：用户显式重试意味着「按现在的配置与现在的时段再试一次」。
   * 与 ①② 的区别刻意写在这里，避免后来者把「复用」误扩展成「永远不重新判定」。
   */
  const clock = input?.clock;
  // 时钟缺失是装配错误而不是「没有路由」：宁可保持旧路径（返回 null），也不要抛进调度循环。
  if (clock === null || typeof clock !== "object" || typeof clock.now !== "function") return null;
  const role = typeof task?.role === "string" ? task.role : "";
  if (role.length === 0) return null;
  return buildPeakValleyDispatchRoute({
    role,
    sessionId: input?.sessionId,
    settingsSnapshot: settingsSnapshotOf(input),
    clock,
  });
}

/**
 * 把 launchInput 上的冻结快照编成 buildRequest 可直接消费的路由对象。
 *
 * 优先级由调用方决定（恢复路由 > 冻结快照 > 提交时预检路由 > 重新解析），本函数只负责
 * **严格校验与形状归一**：字段存在但非法时必须抛稳定错误（fail-closed），绝不当成缺失
 * 继续走「按当前配置重选」——那正是本票据要消除的重建面。
 *
 * 返回的 route 同时满足两处既有读面：
 * - routeMarkerOf(route)（扁平 marker：candidateIndex/fallbackCount/requestedPrimary）；
 * - routeSnapshotMarkerOf(route)（route.snapshot → 完整快照 marker）。
 *
 * @param {object} input - manager 的 launchInput（含 precomputedRoute）。
 * @returns {{snapshot:object, selection:object, route:object}|undefined}
 *   undefined 表示本次派发没有冻结快照。
 */
export function frozenFanoutRouteOf(input) {
  const raw = input?.precomputedRoute;
  if (raw === undefined || raw === null) return undefined;
  const normalized = normalizeRouteSnapshot(raw);
  if (normalized.ok !== true) throw routeSnapshotError(normalized.code, normalized.reason);
  const { snapshot } = normalized;
  const selection = routeSnapshotActiveSelection(snapshot);
  // 防御性不变量：活动候选必须存在，否则后面的 provider/model 会变成 undefined。
  if (selection === undefined) throw routeSnapshotError(ROUTE_SNAPSHOT_INVALID, "active_selection_missing");
  return {
    snapshot,
    selection,
    route: {
      selection: { ...selection },
      candidateIndex: snapshot.candidateIndex,
      // 派发时刻还没有任何降级发生：计数固定为 0（运行期降级再推进它）；
      // 复用冻结快照时同样从 0 开始——上一轮的 fallbackCount 由 child 记录承载，
      // 不是本次 attempt 的既有进度（否则同一 child 的计数会被重复累计）。
      fallbackCount: 0,
      requestedPrimary: { ...snapshot.plan[0] },
      snapshot,
    },
  };
}

/**
 * 读回本 attempt 应写入 child_models 的冻结快照（票据 03）。
 *
 * 顺序与 host/index-agent-snapshot.js 完全一致：先读本次派发的 agentOptions marker，
 * 再回落到 DEG 自有 child_models 记录（cold-resume 的 Host 不还原 agentOptions）。
 * 非法值按「没有」处理——写入边界先归一，绝不让 malformed 快照污染 durable 记录。
 *
 * @param {object} agentOptions - child Agent 的 options（含 EXPERT_ROUTE_SNAPSHOT_MARKER）。
 * @param {object} [persistedRecord] - 已持久化的 child_models 记录（含 route）。
 * @returns {object|undefined} 已归一的快照；都没有/都非法时 undefined。
 */
export function fanoutRouteSnapshotRecordOf(agentOptions, persistedRecord) {
  const fromMarker = normalizeRouteSnapshot(agentOptions?.[EXPERT_ROUTE_SNAPSHOT_MARKER]);
  if (fromMarker.ok === true) return fromMarker.snapshot;
  const fromRecord = normalizeRouteSnapshot(persistedRecord?.route);
  if (fromRecord.ok === true) return fromRecord.snapshot;
  return undefined;
}
