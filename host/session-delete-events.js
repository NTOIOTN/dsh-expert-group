/**
 * 会话删除的「会话移除事件」唯一发射口径（票据 08 · 规格决策 19/43）。
 *
 * ## 为什么单独成模块
 * 「哪些结果态意味着行该消失」这条判定**只能有一处**：列表收敛（客户端看到事件后重拉会话
 * 列表）与结算提示（票据 06/07 的五态计数）必须对同一批目标得出同一结论。把它放在纯函数
 * 作业模块里会把「宿主事件」这种外部副作用塞进不读 ctx、不碰全局的状态机（作业模块的端口
 * 注入约定会被打破）；放在装配段里又会让判定藏在适配代码里，测试只能靠端到端间接覆盖。
 * 因此这里只做两件纯事：**筛选**与**逐个发布**，装配段负责把发布器接上。
 *
 * ## 只发 deleted / absent
 * 规格决策 19：行消失的只有 `deleted`（日志已改名进隔离区）与 `absent`（本来就没有日志，
 * 已登记收敛清理）。其余三态都必须让行留在列表里：
 * - `failed`：日志仍在原地，什么都没动；
 * - `skipped`：目标不可处理（live / live-descendant / pending-cleanup）；
 * - `raced`：改名后发现会话被重新打开，内容已保留（删除未完成）。
 * 一次作业里五种结果可以混合出现，因此判定是**逐目标**的，绝不按聚合计数推断
 * （`counts.deleted > 0` 之类的判据会把整批目标一起当成已删除）。
 *
 * ## 事件名为什么是 `api-session/removed`
 * 它是宿主**已白名单化**的既有事件名（宿主的事件转发器不校验 emit 者，本地 owner peer 直通），
 * 客户端侧对该事件的既有反应就是重拉会话列表。DEG 只是复用它，不新增、不改名、不带额外
 * 载荷——载荷只有一个会话 ID 字符串，与宿主自己的发射形状一致。
 *
 * @module dsh-expert-group/host/session-delete-events
 */
import { SESSION_DELETE_STATES } from "./session-delete-closure.js";

/** 宿主已白名单化的会话移除事件名（客户端据此重拉会话列表）。 */
export const SESSION_REMOVED_EVENT = "api-session/removed";

/**
 * 会**让行消失**的两个结果态（规格决策 19）。
 *
 * 顺序即发布顺序依据之一：同一批目标按作业回执里的先后来发，保证「子先父后」的执行顺序在
 * 事件流里同样成立（宿主侧监听者看到的是同一份确定性顺序）。
 */
export const SESSION_REMOVED_RESULT_STATES = Object.freeze([
  SESSION_DELETE_STATES.DELETED,
  SESSION_DELETE_STATES.ABSENT,
]);

/**
 * 从作业回执里筛出「需要发出会话移除事件」的会话 ID（**纯函数**）。
 *
 * - 只看逐目标 `results`，不看聚合计数（混合结果必须逐目标判定）；
 * - 结果态别名 `deletedWithWarnings` 按 `deleted` 处理（与客户端契约同源，回执里一旦出现
 *   这种带告警的写法，行同样已经消失）；
 * - 未知结果态一律不发（不认识就不动列表：宁可让人刷新一次页面，也不误删行）；
 * - 会话 ID 缺失/空串的结果条目跳过；重复 ID 只发第一次（保持顺序）。
 *
 * @param {object} summary - 作业回执（`{results?: Array<{sessionId, state}>}`）。
 * @returns {string[]} 需要发布事件的会话 ID（去重、保持回执顺序）。
 */
export function removedSessionIdsOf(summary) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const ids = [];
  const seen = new Set();
  for (const result of results) {
    const rawState = typeof result?.state === "string" ? result.state : "";
    const state = rawState === "deletedWithWarnings" ? SESSION_DELETE_STATES.DELETED : rawState;
    if (SESSION_REMOVED_RESULT_STATES.includes(state) !== true) continue;
    const sessionId = typeof result?.sessionId === "string" && result.sessionId.length > 0 ? result.sessionId : undefined;
    if (sessionId === undefined || seen.has(sessionId)) continue;
    seen.add(sessionId);
    ids.push(sessionId);
  }
  return ids;
}

/**
 * 逐个发布会话移除事件（**纯编排**：发布器由调用方注入）。
 *
 * 发布失败**绝不**改变作业结果：事件只是「列表该对账了」的通知，删除本身早已落盘；让一个
 * 宿主事件通道故障把一次成功的删除变成失败，只会造成「明明删掉了却报错」的错误信号。
 * 因此这里逐个 try/catch，并把真正发出去的 ID 作为返回值（诊断与测试都用它当证据，不读计数器）。
 *
 * @param {object} summary - 作业回执。
 * @param {(event: string, sessionId: string) => unknown} publish - 事件发布器。
 * @returns {string[]} 已发布的会话 ID（顺序与 {@link removedSessionIdsOf} 一致）。
 */
export function emitRemovedSessions(summary, publish) {
  if (typeof publish !== "function") return [];
  const emitted = [];
  for (const sessionId of removedSessionIdsOf(summary)) {
    try {
      publish(SESSION_REMOVED_EVENT, sessionId);
      emitted.push(sessionId);
    } catch {
      // 事件通道故障不影响删除结果，也不阻断后续目标的发布。
    }
  }
  return emitted;
}
