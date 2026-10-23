/**
 * 自动恢复预算与反馈账本。
 *
 * 自动恢复上限、重试计数、反馈投递去重账本与 LRU 淘汰原语。
 * 本文件由原 `shared.js` 的 1796–1894 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/recovery-ledger
 */

// ── 自动恢复（自愈监督）：纯函数判定 ────────────────────────────────────────

/**
 * 同一 child 连续自动恢复次数上限：同一 child 连续失败/空返回时，插件最多自动
 * 发送 5 次「继续执行」指令；超过后不再自动恢复，任务记录转为确定失败。
 */
export const AUTO_RECOVERY_LIMIT = 5;

/**
 * 给确定的恢复投递失败追加真实累计次数。所有 failPendingRecoveryOp 分支使用
 * 它，因此父不可用、sendMessage/rebuild reject 与无效 messageId 不会丢失重试
 * 上下文；已经含有该片段时保持幂等，避免嵌套错误路径重复拼接。
 */
export function appendRecoveryRetryCount(message, recoveryCount) {
  const text = typeof message === "string" && message.length > 0 ? message : "自动恢复失败";
  const count = Number.isSafeInteger(recoveryCount) && recoveryCount > 0 ? recoveryCount : 0;
  if (count === 0 || /已自动重试\s+\d+\s+次/.test(text)) return text;
  return text + "；已自动重试 " + count + " 次";
}

/**
 * record.tasks 任务绑定表上限（S2）：超过后按 Map 插入序淘汰最旧。
 * 任务绑定用于成功输出缓存与确定失败记录；64 条足以覆盖
 * 一个 child 生命周期内的活跃任务，防止长期运行内存增长。
 */
export const TASK_BINDING_LIMIT = 64;

/**
 * record.claimed 认领映射上限（S2）：超过后按 Map 插入序淘汰最旧。
 * 认领映射只用于「消息被 inbox 认领但 user/message 未落盘」的归属兜底，
 * 512 条覆盖长时间运行的全部活跃消息，淘汰极旧的条目不影响新归属判定。
 */
export const CLAIMED_LIMIT = 512;

/**
 * durable recovery record 的可淘汰容量软上限：保留最近 256 个**已可淘汰**的 child 恢复记录。
 *
 * 为什么需要它：record 跨 Activation 存活，只有 root 销毁、插件卸载或 owner/session
 * 变化才整批丢弃；若父 root 长期不销毁（长会话），每个已完成 child 的 record 都会
 * 一直留下。超过上限后按 Map 插入序淘汰**最旧且可淘汰**的记录，淘汰资格由
 * host/index-recovery.js 的 recoveryRecordIsEvictable / pruneRecoveryRecords 逐条核对：
 * - 已无进行中恢复（pendingRecoveries.size === 0）的记录不再需要为自动恢复保留；
 * - 以下记录**永不被淘汰**（否则会吞掉尚未结算的信息）：
 *   1) 仍有 live Activation（agents.get(childId) 仍返回 Agent 对象）——record.agent /
 *      record.session 是迟到 settlement 做 exact 身份门控的依据；
 *   2) 仍有进行中恢复 op，或 gatedRecoveryFeedbacks / recoveryFeedbackDeliveries 非空；
 *   3) handoff 域仍持有该 record 的未结算 child turn/end。
 * - **256 是可淘汰历史记录的软上限，不是硬上限**：上述保护成立时记录数可以暂时超过
 *   256，这是「正确性优先于容量」的有意取舍；判定过程中状态缺失或形状异常一律按
 *   「受保护」处理（fail-closed）；
 * - 容量以「record 条数」计数而不是字节数：本常量只是资源上界，不是安全边界。
 * 256 足以覆盖单次会话里并行 + 近期的专家委派，长期内存仍由上限收敛。
 */
export const RECOVERY_RECORD_LIMIT = 256;

/**
 * record.processedFeedbackMessageIds 上限：父 inbox settlement 的 message.id 去重账本。
 *
 * 与 CLAIMED_LIMIT 的关键差别：这里**不做插入序淘汰**。淘汰会让一条迟到副本重新变成
 * 「新 settlement」并消费后续轮次的 token（审核缺陷 A1）；因此达到上限后改为 fail-closed
 * 饱和：不再记录新 id，并置 record.feedbackIdentitySaturated，使没有稳定身份的
 * settlement 只能走保守路径（不得立即消费已结束的 turn group）。饱和需要同一 child
 * 记录累计 4096 条 settlement，属于不可达的极端值，只作为资源上界存在。
 */
export const FEEDBACK_DELIVERY_LIMIT = 4096;

/**
 * 父 inbox settlement 身份账本（A1 的可测纯状态机）。
 *
 * 语义：
 * - `claim(id)` 对同一 id 的第二次调用返回 duplicate=true（副本必须完全跳过消费/排队）；
 * - **永不淘汰**已记账 id：淘汰会让迟到副本重新变成新 settlement；
 * - 达到 limit 后进入饱和：不再记账、`saturated` 置 true，之后 claim 返回
 *   `{duplicate:false, unproven:true}`，调用方必须走保守路径（不提前 resume）。
 *
 * 生命周期：由调用方（index.js 的 child recovery record）持有，record 被 drop/owner
 * 变更时随之丢弃。message.id 是 DSH 为每条消息新铸的 UUID，不存在「同 id 被合法复用
 * 为下一轮真实 settlement」的情况，因此在 record 生命周期内保留 id 是可证明完备的。
 *
 * @param {{limit?:number}} [options] - 记账上限（资源上界，不是安全边界）。
 * @returns {{claim:(id:string)=>{duplicate:boolean,unproven:boolean}, size:number, saturated:boolean}}
 */
export function createFeedbackIdentityLedger({ limit } = {}) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : FEEDBACK_DELIVERY_LIMIT;
  const ids = new Set();
  let saturated = false;
  return {
    claim(id) {
      if (typeof id !== "string" || id.length === 0) return { duplicate: false, unproven: true };
      if (ids.has(id)) return { duplicate: true, unproven: false };
      if (saturated || ids.size >= cap) {
        saturated = true;
        return { duplicate: false, unproven: true };
      }
      ids.add(id);
      return { duplicate: false, unproven: false };
    },
    get size() { return ids.size; },
    get saturated() { return saturated; },
  };
}

/**
 * 把 Map 裁剪到上限（S2 资源上限）：超过 limit 时按插入序删除最旧条目。
 * 就地修改并返回被删除的 key 列表；limit 非正整数或输入非法视为不裁剪。
 * @param {Map} map - 目标 Map（record.tasks / record.claimed）。
 * @param {number} limit - 上限条数。
 * @returns {Array} 被淘汰的 key 列表。
 */
export function evictOldestEntries(map, limit) {
  const removed = [];
  if (!(map instanceof Map) || !Number.isSafeInteger(limit) || limit < 0) return removed;
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === void 0) break;
    map.delete(oldest);
    removed.push(oldest);
  }
  return removed;
}
