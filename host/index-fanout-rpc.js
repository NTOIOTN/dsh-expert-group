/**
 * 入口 fan-out RPC 的只读解析与任务快照补齐域（R4e · 票据 19）。
 *
 * 这一域只服务 RPC 读路径与写动作的**前置判定**：
 * - root / child session 判定（在线 header 的 parentSession/origin 或持久化 child_models）；
 * - 冷恢复根的「仍归属任务」判定（决定能否进入读路径，不授予任何写权限）；
 * - 归属查询（活动绑定 + 已结算只读索引），已回收任务只用于收敛成 task_not_found；
 * - 逐动作能力投影、任务快照的结构化结果补齐与 shard 能力对齐；
 * - 恢复重试专用的“重读当前持久化快照”与 lineage parentSessions 补齐。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册：本域没有 ctx 注册点。写入仍由 dispatcher（票据 20）与
 * manager 命令完成，这里只有只读解析与投影。
 *
 * @module dsh-expert-group/host/index-fanout-rpc
 */
import { structuredProjectionFields } from "../shared/structured.js";

/**
 * 创建 fan-out RPC 只读解析能力面。
 *
 * @param {object} deps - 窄能力面（4 组）。
 * @param {object} deps.identity - 根身份面：`agents.get(sessionId)`、`lineage`
 *   （resolveOwner/restoreParentSessions）。
 * @param {object} deps.storage - settings/storage 域读面：`readSnapshot()`、
 *   `activeBinding()`、`tableEntries(table)`、`setFanoutSnapshot(current)`、
 *   `fanoutSnapshot()`。
 * @param {object} deps.fanout - fan-out Host 晚绑定面：`getFanoutHost()`。
 * @param {object} deps.validation - 校验错误类：`ValidationError`（after 参数 400 语义）。
 * @returns {object} 解析/投影命令面。
 */
export function createFanoutRpcReads({ identity, storage, fanout, validation }) {
  const { ValidationError } = validation;
  function fanoutRpcRootSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
    const agent = identity.agents.get(sessionId);
    if (agent?.session?.header?.parentSession !== void 0) return void 0;
    const recorded = storage.readSnapshot().childModels?.[sessionId];
    if (recorded !== void 0) return void 0;
    return agent;
  }

  function fanoutRpcSessionId(body) {
    return typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  }

  /**
   * 子会话判定（读根解析的前置闸门）。
   *
   * 与既有 get/notification 的判定同源：在线 header 的 parentSession/origin，或持久化
   * child_models 记录。子会话即使以 root 的位置出现，也绝不能读根级 fan-out 视图。
   */
  function fanoutRpcIsChildSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    const agent = identity.agents.get(sessionId);
    const liveChild = agent?.session?.header?.origin === "subagent"
      || agent?.session?.header?.parentSession !== void 0;
    const recorded = storage.readSnapshot().childModels?.[sessionId];
    return liveChild || recorded !== void 0;
  }

  /**
   * 读动作的根解析（票据 09）：live root，或「root 不在线但仍有已归属任务」的冷恢复根。
   *
   * 冷恢复根没有 live Agent，但持久化归属索引里的任务仍必须可查询、可读事件；若它名下
   * 一个任务都没有，就仍是未知 session（404）。子会话与完全未知 id 一律拒绝。
   * 这里只决定「能否进入读路径」，不授予任何写权限。
   */
  function fanoutRpcReadRootSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    if (fanoutRpcIsChildSession(sessionId)) return false;
    if (identity.agents.get(sessionId) !== void 0) return true;
    const fanoutHost = fanout.getFanoutHost();
    if (typeof fanoutHost?.tasksOwnedBy !== "function") return false;
    const owned = fanoutHost.tasksOwnedBy(sessionId);
    return Array.isArray(owned) && owned.length > 0;
  }

  /**
   * 统一归属入口：活动绑定 + 已结算只读索引（RPC 不再直接用 lineage.resolveOwner）。
   *
   * 已回收任务的归属提示只用于把 get/events/写动作收敛成 task_not_found：它不是任务
   * 墓碑（不含任务数据、不进快照/列表），也不会把已回收 id 暴露给其它 root。
   */
  function fanoutRpcOwnerOf(parentTaskId) {
    const fanoutHost = fanout.getFanoutHost();
    if (typeof fanoutHost?.ownerOf === "function") {
      const active = fanoutHost.ownerOf(parentTaskId);
      if (typeof active === "string" && active.length > 0) return active;
    }
    if (typeof fanoutHost?.reclaimedOwnerOf === "function") {
      const reclaimed = fanoutHost.reclaimedOwnerOf(parentTaskId);
      if (typeof reclaimed === "string" && reclaimed.length > 0) return reclaimed;
    }
    return null;
  }

  /** 逐动作能力（票据 09）：Host 是唯一判定入口；旧 Host 缺少该能力时返回 null。 */
  function fanoutRpcCapabilitiesOf(sessionId, parentTaskId) {
    const fanoutHost = fanout.getFanoutHost();
    if (typeof fanoutHost?.capabilitiesOf !== "function") return null;
    const capabilities = fanoutHost.capabilitiesOf(sessionId, parentTaskId);
    return capabilities !== null && typeof capabilities === "object" ? capabilities : null;
  }

  /**
   * 给任务快照附带逐动作能力（list/get/写动作回执共用，保证三处形状一致）。
   *
   * 能力缺失（旧 Host）时原样返回任务，绝不伪造授权；shard 能力按 shardId 对齐，
   * 缺失条目的 shard 保持原样（客户端回退旧行为）。
   */

  /**
   * fan-out RPC 任务快照的结构化结果补齐（票据 30，只读副本）。
   *
   * manager 的权威任务不含 schema/结构化结果（schema 从不进入快照）；这里按
   * attempt.childId 从 child_models 补齐 structured/outputSchemaRequested。
   * task 级只汇总 outputSchemaRequested 与逐 attempt 的结构化结果列表，绝不合并 value。
   */
  function enrichFanoutTaskStructured(task, sessionId) {
    if (task === null || typeof task !== "object" || !Array.isArray(task.shards)) return task;
    let children = {};
    try { children = storage.readSnapshot()?.childModels ?? {}; } catch { children = {}; }
    /** 只从本 root 的 fan-out child 记录补齐：跨 root 的记录绝不进入任务快照。 */
    const ownedRecord = (childId) => {
      const record = typeof childId === "string" ? children[childId] : undefined;
      return record !== null && typeof record === "object" && record.parentId === sessionId ? record : undefined;
    };
    let taskRequested = false;
    const structuredResults = [];
    const shards = task.shards.map((shard) => {
      if (shard === null || typeof shard !== "object") return shard;
      const attempts = Array.isArray(shard.attempts)
        ? shard.attempts.map((attempt) => {
          if (attempt === null || typeof attempt !== "object") return attempt;
          const childId = typeof attempt.childId === "string" ? attempt.childId : "";
          const fields = structuredProjectionFields(ownedRecord(childId));
          if (fields.outputSchemaRequested === true) taskRequested = true;
          if (fields.structured !== undefined) {
            structuredResults.push({
              shardId: typeof shard.shardId === "string" ? shard.shardId : null,
              attempt: Number.isSafeInteger(attempt.attempt) ? attempt.attempt : null,
              childId: childId.length === 0 ? null : childId,
              structured: fields.structured,
            });
          }
          return Object.keys(fields).length === 0 ? attempt : { ...attempt, ...fields };
        })
        : shard.attempts;
      const latest = Array.isArray(attempts) && attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
      return {
        ...shard,
        ...(Array.isArray(attempts) ? { attempts } : {}),
        ...(latest?.structured === undefined ? {} : { structured: latest.structured }),
        ...(latest?.outputSchemaRequested === true ? { outputSchemaRequested: true } : {}),
      };
    });
    return {
      ...task,
      shards,
      ...(structuredResults.length === 0 ? {} : { structured: structuredResults }),
      ...(taskRequested ? { outputSchemaRequested: true } : {}),
    };
  }

  function fanoutRpcTaskWithCapabilities(sessionId, task) {
    if (task === null || task === void 0 || typeof task !== "object") return task;
    const enriched = enrichFanoutTaskStructured(task, sessionId);
    const capabilities = fanoutRpcCapabilitiesOf(sessionId, task.parentTaskId);
    if (capabilities === null) return enriched;
    const shardCapabilities = capabilities.shards !== null && typeof capabilities.shards === "object"
      && !Array.isArray(capabilities.shards)
      ? capabilities.shards
      : {};
    const shards = Array.isArray(enriched.shards)
      ? enriched.shards.map((shard) => {
        const shardId = typeof shard?.shardId === "string" ? shard.shardId : "";
        const shardCapability = shardCapabilities[shardId];
        return shardCapability !== null && typeof shardCapability === "object"
          ? { ...shard, capabilities: shardCapability }
          : shard;
      })
      : enriched.shards;
    return { ...enriched, capabilities, ...(Array.isArray(enriched.shards) ? { shards } : {}) };
  }

  /**
   * 写动作的统一拒绝回执（票据 09）：HTTP 200 + accepted:false + 稳定原因码。
   *
   * 用于「归属匹配、任务已知，但当前没有可写绑定」的冷恢复根与同 id replacement：
   * 任务数据仍按读权限返回（与侧栏快照一致），但写请求不被执行。任务未知/非归属
   * 走 404（调用方在进入本函数前已判定），因此这里不泄露跨 root 的存在性。
   */
  function fanoutRpcSendOwnerNotLive(send, sessionId, parentTaskId, task) {
    const capabilities = fanoutRpcCapabilitiesOf(sessionId, parentTaskId);
    send(200, {
      ok: true,
      accepted: false,
      changed: false,
      reason: "owner_not_live",
      parentTaskId,
      task: fanoutRpcTaskWithCapabilities(sessionId, task),
      ...(capabilities === null ? {} : { capabilities }),
    });
  }

  function fanoutRpcAfter(value) {
    if (value === undefined) return 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError("after 必须是非负整数");
    return value;
  }

  /**
   * 重读**当前**持久化 fan-out 快照（恢复重试专用的读边界）。
   *
   * 为什么不能只读 storage.fanoutSnapshot()：那只是「初始化读表」或「本进程成功落盘」
   * 时写入的投影缓存。恢复失败后 persist 被 fail-closed 跳过，缓存会一直停留在失败的那份
   * 快照上；而重试的语义是「重新读取当前持久化快照」，磁盘内容可能已被外部修复（人工修复、
   * 另一进程替换、手工还原备份）。因此这里直接从当前 ready binding 的 fanout 表读一次
   * （**只读**，绝不写入），并同步投影缓存，让随后的 fanoutHost.restore() 读到同一份数据。
   *
   * storage 尚未 ready 或表读取失败时回落到既有投影缓存：恢复重试仍可执行（结果是
   * 「没有可恢复快照」而不是未知异常），不会把存储故障伪装成成功。
   */
  function refreshFanoutSnapshotFromStorage() {
    const binding = storage.activeBinding();
    if (binding !== void 0 && binding.fanoutTable !== void 0) {
      const entries = storage.tableEntries(binding.fanoutTable);
      if (entries !== void 0) {
        const current = entries.find(([key]) => key === "current")?.[1];
        storage.setFanoutSnapshot(current);
        return current;
      }
    }
    return storage.fanoutSnapshot();
  }

  /**
   * 重试恢复前补齐 lineage 的 parentSessions 寻址索引。
   *
   * 冷启动路径在 restore 之前会调用 restoreParentSessions；重试走的是同一条恢复语义，
   * 缺少这一步时：需要 live root 的 queued 任务会以 parentId=undefined 进入 deferred，
   * 下一次 snapshotForStorage 就会丢掉它的 parentSessions 映射（重启后该任务不再属于任何根）；
   * 非延迟的恢复任务也无法经由 bindParentTask 建立活动绑定（终态任务由已结算索引兜底，
   * 因此不受影响）。
   *
   * 只补**当前没有归属**的条目：restoreParentSessions 会删除同名任务的 parentTokens
   * （「没有绑定当时的 exact 代际证据 → 续作 fail-closed」），对仍被 live 绑定拥有的任务
   * 调用它会无谓地撤销续作写权限。重试只服务「失败后还没有任何归属」的任务，因此过滤
   * 掉已有 owner 的条目既满足恢复需要，也不会改动活动任务的权限证据。
   */
  function rehydrateFanoutOwnership(snapshot) {
    const source = snapshot?.parentSessions;
    if (source === null || typeof source !== "object" || Array.isArray(source)) return 0;
    const missing = {};
    for (const [parentTaskId, parentId] of Object.entries(source)) {
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) continue;
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      if (identity.lineage.resolveOwner(parentTaskId) !== undefined) continue;
      missing[parentTaskId] = parentId;
    }
    if (Object.keys(missing).length === 0) return 0;
    return identity.lineage.restoreParentSessions({ parentSessions: missing });
  }

  return {
    fanoutRpcRootSession,
    fanoutRpcSessionId,
    fanoutRpcIsChildSession,
    fanoutRpcReadRootSession,
    fanoutRpcOwnerOf,
    fanoutRpcCapabilitiesOf,
    enrichFanoutTaskStructured,
    fanoutRpcTaskWithCapabilities,
    fanoutRpcSendOwnerNotLive,
    fanoutRpcAfter,
    refreshFanoutSnapshotFromStorage,
    rehydrateFanoutOwnership,
  };
}
