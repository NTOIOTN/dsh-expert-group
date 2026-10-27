/**
 * 主代理（Orchestrator）模型配置的**功能启用切点**（orchestratorEpoch）持久化。
 *
 * ## 为什么需要切点
 * "无请求头"只能证明会话**还没发过请求**，不能证明它是功能上线**之后**新建的：一个
 * 功能上线前创建、至今没发过请求的历史会话同样没有请求头。若只看请求头，升级后第一次
 * 打开这样的会话就会被套用配置——这正是 B3 的缺陷。
 *
 * 切点语义：**首次初始化**时把"本功能开始生效的时刻"写进 DEG 自己的 storage domain，
 * 之后永不改动（重启后仍用同一个值）。判定新会话必须同时满足：
 * 1. 会话头 `createdAt >= orchestratorEpoch`（会话确实产生于切点之后）；
 * 2. 没有请求头（本次新建）；
 * 3. 本进程内没有该会话的 applied 记录（由运行期 manager 另外检查）。
 *
 * ## 存储形态
 * 复用既有 storage domain（`dsh_expert_group`，version 1）的**新表** `orchestrator_state`，
 * 固定一行 key=`epoch`、value=`{ epoch }`。新增表不是破坏性变更（与票据 28 的
 * `fanout_templates` 同一处理方式），也绝不新开文件、绝不塞进 settings——切点是运行期
 * 事实，不是用户可编辑偏好。
 *
 * ## 并发与"只写一次"
 * - 进程内缓存：一旦拿到值（读到的或自己写的）就固定下来，后续调用直接返回；
 * - 写入在 storage 写串行链内进行，并**在临界区内重读**：并发/多实例/卸载重放下只有
 *   第一个真正写成功，后来者读到已有值即放弃；
 * - 写入失败不阻塞功能：本次进程退回"以首次初始化时刻为切点"（只会**更少**套用，
 *   绝不更激进），之后的 `ensure` 会再尝试落盘一次。
 *
 * @module dsh-expert-group/host/orchestrator-epoch
 */

/** storage domain 表名（与 host/storage-domain-schema 的登记必须一致）。 */
export const ORCHESTRATOR_STATE_TABLE = "orchestrator_state";

/** 切点记录的固定 key：该表只有这一行，绝不用会话 id 当键。 */
export const ORCHESTRATOR_EPOCH_KEY = "epoch";

/**
 * 创建切点存储（读 + 首次写入）。
 *
 * @param {object} deps - 窄能力面（2 组 + 可选日志）。
 * @param {object} deps.storageBinding - host.storage 绑定读面：`active()` / `isCurrent(binding)`。
 * @param {object} deps.persistence - 持久化原语：`enqueueWrite(task)`、
 *   `persistDomainEntry({table,key,value,isCurrent})`。
 * @param {object} [deps.logger] - 只记固定类别与安全错误名（绝不输出 message 原文）。
 * @returns {{ensure: (nowMs: number) => Promise<number>, readCached: () => (number|null)}}
 *   切点命令面。
 */
export function createOrchestratorEpochStore({ storageBinding, persistence, logger }) {
  /** 已确认的切点（读到的或刚写成功的）；null = 尚未确认。 */
  let confirmedEpoch = null;
  /** 本进程内的兜底切点：落盘失败时仍按它判定（只会更少套用）。 */
  let fallbackEpoch = null;
  /** 在途的落盘任务（并发调用共享同一个，绝不重复写第二条）。 */
  let persisting = null;

  function logFailure(action, error) {
    try {
      const label = error instanceof Error ? error.name : typeof error;
      logger?.warn?.("dsh-expert-group: orchestrator epoch " + action + " failed: " + label);
    } catch {
      // 日志失败绝不影响判定。
    }
  }

  /** 把任意时间归一成可持久化的毫秒数；非法值返回 null（调用方决定兜底）。 */
  function normalizeEpoch(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  /**
   * 同步读取已持久化的切点。
   *
   * 只读当前 ready binding；binding 未就绪、表缺失、读失败、值非法都返回 null
   * （= "还没有切点"，由调用方决定初始化并落盘）。读取面**永不抛错**。
   *
   * @returns {number|null} 已持久化的切点。
   */
  function readStoredEpoch() {
    const binding = storageBinding.active();
    if (binding?.orchestratorStateAuthoritative !== true || binding.orchestratorStateTable === void 0) return null;
    let entries;
    try {
      entries = [...binding.orchestratorStateTable.entries()];
    } catch {
      return null;
    }
    for (const [key, value] of entries) {
      if (key !== ORCHESTRATOR_EPOCH_KEY) continue;
      return normalizeEpoch(value?.epoch);
    }
    return null;
  }

  /**
   * 首次落盘（只写一次）。
   *
   * 临界区内重读：另一个进程/并发调用已经写过就放弃写入，返回已经存下来的那一个。
   *
   * @param {number} epoch - 本次初始化确定的切点。
   * @returns {Promise<number>} 最终生效的切点。
   */
  async function persistOnce(epoch) {
    await persistence.enqueueWrite(async () => {
      const binding = storageBinding.active();
      if (binding?.orchestratorStateAuthoritative !== true || binding.orchestratorStateTable === void 0) {
        throw new Error("storage domain is not ready for orchestrator epoch write");
      }
      // 临界区内重读：并发/多实例下只有第一个写成功，后来者直接沿用已有切点。
      const existing = readStoredEpoch();
      if (existing !== null) return;
      const result = await persistence.persistDomainEntry({
        table: binding.orchestratorStateTable,
        key: ORCHESTRATOR_EPOCH_KEY,
        value: { epoch },
        isCurrent: () => storageBinding.isCurrent(binding),
      });
      if (result.detached === true) {
        throw new Error("storage domain binding was replaced during orchestrator epoch write");
      }
    });
    confirmedEpoch = readStoredEpoch() ?? epoch;
    return confirmedEpoch;
  }

  /**
   * 取当前切点（必要时初始化并落盘一次）。
   *
   * 返回值恒为可用毫秒数：storage 不可用时退回"首次初始化时刻"，因此在任何宿主形态下
   * 判据都能工作，只是失败时更保守（会话被判成切点之前 => 不套用）。
   *
   * @param {number} nowMs - 宿主时钟给出的"现在"（首次调用时即功能启用时刻）。
   * @returns {Promise<number>} 切点。
   */
  function ensure(nowMs) {
    if (confirmedEpoch !== null) return Promise.resolve(confirmedEpoch);
    const stored = readStoredEpoch();
    if (stored !== null) {
      confirmedEpoch = stored;
      return Promise.resolve(stored);
    }
    if (fallbackEpoch === null) fallbackEpoch = normalizeEpoch(nowMs) ?? Date.now();
    if (persisting === null) {
      // 落盘失败后清空在途标记：后续 ensure 会再试一次；成功后 confirmedEpoch 已固定。
      persisting = persistOnce(fallbackEpoch).catch((error) => {
        logFailure("persist", error);
        persisting = null;
        return fallbackEpoch;
      });
    }
    return persisting;
  }

  return {
    ensure,
    /** 只读诊断：已确认的切点（未初始化时为 null）。 */
    readCached: () => confirmedEpoch,
  };
}
