/**
 * Host 关注点模块：root run 终止快照注册表。
 *
 * 旧实现同时持有"事件队列 registry"和"root completion 去重状态机"，客户端必须靠
 * 短时轮询按游标消费事件批次，投递正确性因此依赖轮询时机与队列 TTL。新实现只保留
 * 生命周期权威真正需要的那一份状态：**每个 root run 的当前终止快照**。
 *
 * 快照只在 root 主代理 turn 已终止、且该 root 的全部递归后代专家都不在运行时写入
 * （递归判定 fail closed，见 shared.snapshotRunningRootDescendants），并一直保留到
 * 下一次真实用户输入开启新 run 或 root 被 dispose。客户端任何时刻读取同一份权威结果，
 * 因此不需要"短时事件轮询"就能拿到正确状态。
 *
 * 终止原因不再被过滤成"只有成功才通知"：completed / blocked / error / aborted /
 * interrupted / max-tokens 都会成为快照原因，由客户端按原因显示不同文案。
 *
 * @module dsh-expert-group/host/notifications
 */
import { snapshotRunningRootDescendants } from "../shared.js";

/**
 * DSH turn/end 的已知终止原因。TurnEndReason 是 merge-extensible 联合类型，
 * 表外的 kind 一律归一为 unknown，绝不能被当作"completed"。
 */
export const ROOT_TERMINATION_REASONS = Object.freeze([
  "completed",
  "blocked",
  "error",
  "aborted",
  "interrupted",
  "max-tokens",
]);

/** 归一化终止原因：缺失或未知 kind 都返回 unknown。 */
export function normalizeRootTerminationReason(reason) {
  const kind = typeof reason?.kind === "string" ? reason.kind.trim() : "";
  if (kind.length === 0) return "unknown";
  return ROOT_TERMINATION_REASONS.includes(kind) ? kind : "unknown";
}

const EMPTY_VIEW = Object.freeze({ rootId: null, generation: null, runSeq: 0, snapshot: null });

/**
 * 创建 root run 终止快照模块。
 *
 * @param {object} [options]
 * @param {() => unknown} [options.listAgents] - 读取全部 live Agent 的查询；缺失即未知。
 * @param {() => number} [options.now] - 可注入时钟，测试用它固定快照时间戳。
 */
export function createNotificationModule({ listAgents, now = () => Date.now() } = {}) {
  /** rootId -> { generation, runSeq, publishedRunSeq, snapshot } */
  const roots = new Map();
  // 发布序号单调递增：客户端用 generation+runSeq+seq 去重，因此撤销后又真正终止的
  // 同一次 run 仍然可以被提示，而同一次发布永远只提示一次。
  let publishSeq = 0;
  let disposed = false;

  const timestamp = () => {
    const value = Number(now());
    return Number.isFinite(value) ? Math.trunc(value) : Date.now();
  };
  const validIdentity = (rootId, generation) => typeof rootId === "string" && rootId.length > 0
    && Number.isSafeInteger(generation) && generation > 0;

  /**
   * 读取（可选创建）某个 exact root generation 的状态。generation 单调：迟到的旧代际
   * 不能读取或覆盖新代际的状态，同 id 的 replacement 因此不会继承旧 root 的快照。
   */
  function stateOf(rootId, generation, create) {
    if (!validIdentity(rootId, generation)) return void 0;
    const existing = roots.get(rootId);
    if (existing !== void 0 && generation < existing.generation) return void 0;
    if (existing !== void 0 && existing.generation === generation) return existing;
    if (create !== true) return void 0;
    const created = { generation, runSeq: 0, publishedRunSeq: null, snapshot: null };
    roots.set(rootId, created);
    return created;
  }

  const api = {
    /** 插件启动/恢复时为已存在的 root 建立空状态：不能继承同 id 旧 root 的终止快照。 */
    activateRoot({ rootId, generation } = {}) {
      if (disposed) return false;
      const state = stateOf(rootId, generation, true);
      if (state === void 0) return false;
      state.snapshot = null;
      state.publishedRunSeq = null;
      return true;
    },
    /**
     * 真实用户输入开启新 run：runSeq 单调递增并清空上一 run 的快照与发布资格。
     * 这是"同一 root 再次提示"的唯一入口——宿主注入的 subagent feedback 不经过这里。
     */
    beginRootRun({ rootId, generation } = {}) {
      if (disposed) return false;
      const state = stateOf(rootId, generation, true);
      if (state === void 0) return false;
      state.runSeq += 1;
      state.publishedRunSeq = null;
      state.snapshot = null;
      return true;
    },
    /**
     * root turn 已终止：只有递归后代门控确认"没有任何专家在运行"时才写入快照。
     * 门控未知（agents.list 缺失/抛错/身份或状态不完整）与仍有后代在运行时都拒绝发布，
     * 并且不消耗本 run 的发布资格——专家真正结束的那一轮仍然可以通知。
     * @returns {{published: boolean, reason?: string, snapshot?: object}}
     */
    recordTermination({ rootId, generation, reason, turn } = {}) {
      if (disposed) return { published: false, reason: "disposed" };
      const state = stateOf(rootId, generation, false);
      if (state === void 0) return { published: false, reason: "identity" };
      // 每个 root run 至多一次：同 run 的后续 turn（例如子代理结算回唤出的续接 turn）
      // 一律拒绝，直到 beginRootRun 开启新 run。
      if (state.publishedRunSeq === state.runSeq) return { published: false, reason: "already-published" };
      const gate = snapshotRunningRootDescendants(listAgents, rootId);
      if (gate.known !== true) return { published: false, reason: gate.reason ?? "runtime-child-query-unknown" };
      if (gate.blocked === true) return { published: false, reason: gate.reason ?? "runtime-running-descendant" };
      const snapshot = Object.freeze({
        seq: ++publishSeq,
        runSeq: state.runSeq,
        generation: state.generation,
        reason: normalizeRootTerminationReason(reason),
        turn: Number.isSafeInteger(turn) ? turn : null,
        at: timestamp(),
      });
      state.snapshot = snapshot;
      state.publishedRunSeq = state.runSeq;
      return { published: true, snapshot };
    },
    /**
     * 同一 turn 在 turn/end 之后又开始新 step，说明 listener 通过 steer 续接了本次运行，
     * 刚写入的"终止"并不成立：撤销快照并归还本 run 的发布资格，让真正的终止仍能通知。
     * 只有 turn 完全一致的撤销才生效，后续新 turn 不会被误撤销。
     *
     * 代际校验（fail-closed）：撤销面只拿得到 rootId，无法自己区分调用方属于哪一代，
     * 而 replacement 之后同一 rootId 的下一代际**可以重用同一个 turn 号**——旧代际 root
     * 的迟到 step/start 因此能撤销新代际刚发布的终止快照。调用方声明 generation 时
     * 必须与当前状态代际严格一致（缺失、非法或不等都拒绝）。
     *
     * 兼容边界：未声明 generation 的历史调用方（index.js 的 session/event 路由）保留
     * 原来的同 turn 语义——上游用 exact root Agent + Session 身份守卫拦住了跨代际事件；
     * 新增调用方一律应带上 generation，才能获得完整的跨代际保护。
     *
     * @param {object} [input]
     * @param {string} [input.rootId]
     * @param {number} [input.turn] - 可省略；省略时不校验 turn 号（历史语义）。
     * @param {number} [input.generation] - 调用方所属的 root 代际；声明即强校验。
     * @returns {boolean} 真正撤销返回 true。
     */
    revokeTermination({ rootId, turn, generation } = {}) {
      if (disposed) return false;
      const state = roots.get(rootId);
      if (state === void 0 || state.snapshot === null) return false;
      if (generation !== undefined && generation !== state.generation) return false;
      if (Number.isSafeInteger(turn) && state.snapshot.turn !== turn) return false;
      state.snapshot = null;
      state.publishedRunSeq = null;
      return true;
    },
    /** 只读视图：RPC 与测试共用的权威读取面；未知 root 返回空视图而不是报错。 */
    snapshotOf(rootId) {
      if (disposed || typeof rootId !== "string" || rootId.length === 0) return EMPTY_VIEW;
      const state = roots.get(rootId);
      if (state === void 0) return Object.freeze({ rootId, generation: null, runSeq: 0, snapshot: null });
      return Object.freeze({ rootId, generation: state.generation, runSeq: state.runSeq, snapshot: state.snapshot });
    },
    /** root replacement/dispose：删除该 root 的全部状态；旧代际的迟到退休无效。 */
    retireRoot(rootId, generation) {
      if (disposed) return false;
      const state = roots.get(rootId);
      if (state === void 0 || state.generation !== generation) return false;
      roots.delete(rootId);
      return true;
    },
    describe: () => Object.freeze({
      roots: roots.size,
      hasAgentQuery: typeof listAgents === "function",
      reasons: [...ROOT_TERMINATION_REASONS],
      disposed,
    }),
    /** 幂等清理：丢弃全部 root 状态；之后不接受新工作也不返回旧快照。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      roots.clear();
    },
  };
  return Object.freeze(api);
}
