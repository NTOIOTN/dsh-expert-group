/**
 * 会话级模型覆盖的 **durable 写入**（RPC 端点与主代理运行期共用同一实现）。
 *
 * ## 为什么单独成一个模块
 * 会话覆盖现在有两个写入者：
 * 1. **RPC 端点**（`session-override-set` / `session-override-clear`）：持有客户端
 *    读到的 `expectedRevision`，必须走 CAS 栅栏；
 * 2. **主代理运行期**（"会话模型"弹窗与主界面 picker 的手动接管）：Host 内部动作，
 *    没有客户端草稿，因此没有 CAS 依据，但必须复用**同一套**持久化顺序、代次推进与
 *    失败回滚，绝不旁路。
 *
 * 两者共用的不变式（与迁移前的内联实现逐条一致）：
 * - 写前必须确认 binding 就绪（session 表 + 代次表都 authoritative）且仍是当前代；
 * - **先写代次、再写内容**：反过来的话内容成功而代次失败会留下"覆盖已变但 revision
 *   未前进"的状态，下一个持旧代次的写入会静默覆盖这次结果；
 * - 内容写失败时尽力把代次回滚到旧值；
 * - 清掉最后一个角色后**删除整行**（读取面继续用"缺行"表达没有覆盖）；
 * - 写入结束记录一次持久化健康状态；CAS 冲突不算存储故障。
 *
 * @module dsh-expert-group/host/session-override-store
 */
import { ORCHESTRATOR_SELECTION_KEY } from "../shared/model-route.js";
import { persistDomainEntry, removeDomainEntry } from "../storage.js";

/** 会话覆盖表未就绪时的稳定错误信息（与迁移前逐字一致）。 */
const NOT_READY_MESSAGE = "storage domain is not ready for session override write";
/** binding 在写入途中被替换时的稳定错误码（RPC 层据此提示重试）。 */
const GENERATION_STALE_CODE = "PERSISTENCE_GENERATION_STALE";

/**
 * 创建会话覆盖写入能力面。
 *
 * @param {object} deps - 窄能力面（3 组）。
 * @param {object} deps.storage - 存储写面：`enqueueWrite(task)`、`observeStorageWrite(ok,error,source)`、
 *   `storageBinding`（`active()` / `isCurrent(binding)`）。
 * @param {object} deps.reads - 只读投影：`source()`（一致快照）与
 *   `sessionOverrideProjectionOf(snap, sessionId)`。
 * @param {object} deps.models - `sessionOverrideConflictError(currentRevision, overrides)`，
 *   保持 RPC 层的错误类身份与错误码不变。
 * @returns {{writeRole: Function, writeOrchestratorOverride: Function}} 写入命令面。
 */
export function createSessionOverrideStore({ storage, reads, models }) {
  const { enqueueWrite, observeStorageWrite, storageBinding } = storage;
  const { source, sessionOverrideProjectionOf } = reads;
  const { sessionOverrideConflictError } = models;

  /**
   * 取当前可写的 binding；未就绪直接抛错（与迁移前同一句错误）。
   *
   * @returns {object} ready binding。
   */
  function requireBinding() {
    const binding = storageBinding.active();
    if (binding?.sessionAuthoritative !== true
      || binding?.sessionOverrideMetaAuthoritative !== true
      || binding.sessionOverrideMetaTable === void 0) {
      throw new Error(NOT_READY_MESSAGE);
    }
    return binding;
  }

  /** 构造 binding 失效错误（与迁移前同一 code / category）。 */
  function generationStaleError() {
    const error = new Error("storage domain binding was replaced");
    error.code = GENERATION_STALE_CODE;
    error.category = "generation-stale";
    return error;
  }

  /**
   * 一次 role 覆盖的 durable 变更（写代次 -> 写内容 / 删行，失败回滚代次）。
   *
   * `expectedRevision === undefined` 表示 Host 内部写入：没有客户端草稿可比，
   * 因此不做 CAS（仍推进代次，让持有旧代次的客户端读到冲突而不是静默覆盖）。
   *
   * @param {object} params - 变更入参。
   * @param {string} params.sessionId - 根会话 id。
   * @param {string} params.role - 角色键或保留键 `orchestrator`。
   * @param {object|undefined} params.selection - 归一后的选择（clear 时为 undefined）。
   * @param {boolean} params.clear - true = 删除该 role 的覆盖。
   * @param {number|undefined} params.expectedRevision - 客户端读到的代次（CAS 用）。
   * @returns {Promise<void>} 写入完成。
   */
  function writeRole({ sessionId, role, selection, clear, expectedRevision }) {
    return enqueueWrite(async () => {
      const binding = requireBinding();
      if (!storageBinding.isCurrent(binding)) throw new Error("storage domain binding was replaced");
      // CAS 读与写必须落在同一个串行临界区：前一批写完成后这里才是权威代次。
      const current = source();
      const view = sessionOverrideProjectionOf(current, sessionId);
      if (expectedRevision !== void 0 && view.revision !== expectedRevision) {
        throw sessionOverrideConflictError(view.revision, view.overrides);
      }
      const next = { ...(current.sessionOverrides?.[sessionId] ?? {}) };
      if (clear === true) delete next[role];
      else next[role] = selection;
      const nextRevision = view.revision + 1;
      const isCurrent = () => storageBinding.isCurrent(binding);
      const metaWrite = await persistDomainEntry({
        table: binding.sessionOverrideMetaTable,
        key: sessionId,
        value: { revision: nextRevision },
        isCurrent,
      });
      if (metaWrite.detached) throw generationStaleError();
      try {
        if (Object.keys(next).length > 0) {
          const result = await persistDomainEntry({
            table: binding.sessionTable,
            key: sessionId,
            value: next,
            isCurrent,
          });
          if (result.detached) throw generationStaleError();
        } else {
          // 清掉最后一个角色后删除整行：读取面继续把"没有覆盖"表达为缺行，
          // 旧读者看到的形状与从未写过完全一致（不留下空对象）。
          const removed = await removeDomainEntry({ table: binding.sessionTable, key: sessionId, isCurrent });
          if (removed.detached) throw generationStaleError();
        }
      } catch (error) {
        // 内容写失败：尽力回滚代次，避免"内容没变、代次却前进"的无谓冲突。
        try {
          await persistDomainEntry({
            table: binding.sessionOverrideMetaTable,
            key: sessionId,
            value: { revision: view.revision },
            isCurrent,
          });
        } catch { /* 回滚是尽力而为：失败也只是多一次可重试的冲突提示。 */ }
        throw error;
      }
    }).then(() => {
      observeStorageWrite(true, void 0, "session_overrides");
    }, (error) => {
      // 冲突不是存储故障：只在真正的写入失败上记录健康状态。
      if (error?.code !== "SESSION_OVERRIDE_CONFLICT") observeStorageWrite(false, error, "session_overrides");
      throw error;
    });
  }

  /**
   * Host 内部写入：把"用户在主界面 picker 手动选的模型"持久化成会话覆盖。
   *
   * 语义（B2 第 3 条）：手动接管只在本次会话内有效，但**必须重启后仍然只影响该会话**，
   * 因此落 session_overrides.orchestrator，而不是改写全局配置。
   *
   * 与 RPC 写入的差异只有一个：没有 `expectedRevision`（没有客户端草稿），因此不做 CAS；
   * 代次仍照常推进，持旧代次的设置页会读到冲突而不会静默覆盖这次手动选择。
   *
   * @param {object} params - { sessionId, selection }。
   * @returns {Promise<void>} 写入完成。
   */
  function writeOrchestratorOverride({ sessionId, selection }) {
    return writeRole({
      sessionId,
      role: ORCHESTRATOR_SELECTION_KEY,
      selection,
      clear: false,
      expectedRevision: void 0,
    });
  }

  return { writeRole, writeOrchestratorOverride };
}
