/**
 * fan-out 快照序列化（R3-14：从组合根 fanout.js 的 "snapshot serializer" 工厂整段迁出）。
 *
 * ## 职责与状态所有权（C5）
 * 本模块**不持有任何可变状态**：只做只读投影，从 store / limits / events 取窄投影拼装快照。
 * 快照内容与体积来自同一次 stringify（serializeSnapshotEnvelope），不存在第二事实源。
 *
 * ## 迁移说明（R3-14）
 * 只做代码搬迁：投影字段、字节口径与 degraded 语义逐行不变，仅补充 import 与 export。
 *
 * @module dsh-expert-group/fanout/snapshot
 */
import { describeBudgetViolation } from "../resource-budget.js";
import { normalizeRouteSnapshot } from "../shared/route-snapshot.js";
import { PROCESS_INSTANCE, SNAPSHOT_VERSION, TIMEOUT_PROJECTION_VERSION } from "./errors.js";
import { cloneJson, normalizeIdSet } from "./validation.js";

/**
 * attempt 的派发路由冻结快照字段（票据 03 的序列化白名单）。
 *
 * 只写**已归一**的形状：attempt.route 只可能来自 shared/route-snapshot.js 的构造入口，
 * 这里再校验一次是防御「运行期被注入半截快照」——非法值不落盘（否则恢复侧会按 fail-closed
 * 拒绝整份快照，反而丢掉整个任务）。缺失时返回空对象，旧快照形状逐字不变。
 *
 * @param {object} attempt - manager 的 attempt 对象。
 * @returns {object} 需要展开进快照的字段（可能为空对象）。
 */
function attemptRouteField(attempt) {
  if (attempt?.route === undefined) return {};
  const normalized = normalizeRouteSnapshot(attempt.route);
  return normalized.ok === true ? { route: normalized.snapshot } : {};
}

export function createFanoutSerializer({ store, limits, events, budget, config }) {
  const budgetPolicy = budget;
  const ledger = events;
  const limitConfig = limits.limitConfig;


  /**
   * 构建可序列化快照的**内部投影**：只含逻辑状态，不含 timer/promise/child 句柄。
   *
   * 返回值仍然引用内部状态（result/error/配置对象都是原引用），因此绝不能直接交给
   * 外部：所有对外出口（snapshot() / 持久化）都经过 serializeSnapshotEnvelope() 取
   * 深拷贝。本函数只是把"快照应该长什么样"收敛到唯一一处，避免内容投影出现第二实现。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>}} [options] - 回收候选快照的排除集合
   *   （票据 05）：命中的父任务不进入 tasks 数组。事件历史保持原样——回收不删除历史事件，
   *   但回收后这些事件不再按 parentTaskId 可查询（查询返回 task_not_found）。
   */
  function buildSnapshotPayload(options = {}) {
    const omittedParentTaskIds = normalizeIdSet(options?.omitParentTaskIds);
    return {
      version: SNAPSHOT_VERSION,
      sequence: ledger.sequenceValue(),
      nextTaskNumber: store.nextTaskNumberValue(),
      /**
       * 进程身份（票据 07）：恢复时据此自动判定停止证据边界。
       *
       * 同一个进程内重建（值相同）只能得到 unknown——旧 child 可能仍然活着；
       * 值不同或缺失（旧版本快照）说明快照来自另一个进程，才允许 process-restart。
       */
      processInstance: PROCESS_INSTANCE,
      // 超时投影版本（票据 06）：告诉恢复路径「本快照的 shard.timeoutMs 是显式覆盖」，
      // 而不是像旧快照那样只能从 attempt.timeoutMs 反推。
      timeoutProjection: TIMEOUT_PROJECTION_VERSION,
      // 写最近一次解析得到的默认上限（未解析时为构造/恢复值），并附带来源标记：
      // - concurrencySource=live：该字段只是诊断，真实权威是恢复进程的当前设置；
      // - concurrencySource=snapshot：本进程没有 live resolver，该字段是冻结值。
      // restore 对有无标记的快照统一按"尽量 live"处理（有解析函数就 live，否则冻结），
      // 标记只服务外部读者与诊断，不改变恢复决策（票据 03）。
      defaultConcurrencyLimit: limitConfig.lastResolvedDefaultConcurrencyLimit,
      concurrencySource: limitConfig.resolverSource,
      roleLimits: limitConfig.roleLimits,
      // provider 级映射（票据 26）：与 roleLimits 同层持久化。函数形式（live）在
      // JSON 序列化时自然消失，因此快照里有值就说明这是一个可冻结的静态映射。
      providerLimits: limitConfig.providerLimits,
      writeRoles: store.conflictConfig.writeRoles,
      defaultAllowOverlap: store.conflictConfig.defaultAllowOverlap,
      parentRotation: store.rotationCursorSnapshot(),
      events: ledger.historyEvents().map((event) => cloneJson(event)),
      tasks: [...store.allTasks()]
        .filter((task) => omittedParentTaskIds === null || !omittedParentTaskIds.has(task.parentTaskId))
        .map((task) => ({
        parentTaskId: task.parentTaskId,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        role: task.role,
        basePrompt: task.basePrompt,
        status: task.status,
        // 逻辑轮次持久化：冷恢复后仍能区分「第几轮复用」并继续递增。
        round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
        // continuation 幂等记录持久化：重启后同一 requestId 仍然 duplicate=true。
        ...(store.continuationRequestCount(task) === 0 ? {} : { continuationRequests: cloneJson(task.continuationRequests) }),
        allowOverlap: task.allowOverlap,
        ...(task.concurrencyLimit === undefined ? {} : { concurrencyLimit: task.concurrencyLimit }),
        // 父任务级默认超时必须随快照持久化，否则重启后未显式给出超时的分片
        // 会静默回到角色默认值（票据 06）。
        ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
        // provider 归属随任务快照持久化（票据 26）：重启后 provider 级计数必须还能
        // 按同一归属重建；旧快照没有该字段时保持 undefined（限流不生效，不是错误）。
        ...(task.provider === undefined ? {} : { provider: task.provider }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        settledAt: task.settledAt ?? null,
        parentCancelRequested: task.parentCancelRequested === true,
        shards: task.shards.map((shard) => ({
          shardId: shard.shardId,
          ...(shard.name === undefined ? {} : { name: shard.name }),
          prompt: shard.prompt,
          status: shard.status,
          createdAt: shard.createdAt,
          updatedAt: shard.updatedAt,
          ...(shard.cancelRequested === true ? { cancelRequested: true } : {}),
          // 分片级超时只写**显式覆盖**（票据 06）：父任务/角色默认值不能被写成
          // 分片覆盖，否则恢复后的超时来源会被永久冻结。
          ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
          // 恢复续跑被 attempt 预算拦下的原因码必须随持久化快照落盘（票据 08），
          // 否则重启后 UI 无法解释"为什么中断分片没有继续"。
          ...(shard.resumeBlocked === undefined ? {} : { resumeBlocked: cloneJson(shard.resumeBlocked) }),
          attempts: shard.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
            ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
            affectedPaths: [...attempt.affectedPaths],
            ...(attempt.cancelRequested === true ? { cancelRequested: true } : {}),
            ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
            ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
            ...(attempt.messageId === undefined ? {} : { messageId: attempt.messageId }),
            ...(attempt.result === undefined ? {} : { result: attempt.result }),
            ...(attempt.error === undefined ? {} : { error: attempt.error }),
            // 停止证据与 attempt 身份随快照持久化（票据 07）：重启后仍能回答"哪些 attempt
            // 已逻辑终态但执行未确认"，并让恢复后的重试/续作 gate 保持同一判据。
            ...store.attemptStopSnapshot(attempt),
            // 派发路由冻结快照（票据 03）：逐 attempt 的 durable 记录。running→interrupted
            // 的状态重写不得丢它，恢复后的执行也不得按当前配置重选。
            ...attemptRouteField(attempt),
          })),
        })),
      })),
      // 执行代次计数器随快照持久化：恢复后新建 attempt 的代次必须大于全部历史代次，
      // 否则迟到证据可能"恰好匹配"一个新 attempt。
      nextExecutionGeneration: store.nextExecutionGenerationValue(),
    };
  }

  /**
   * 单次序列化快照：**同一份 JSON 文本**同时产出内容与体积。
   *
   * - payload：由该文本 parse 出的深拷贝，与内部状态完全隔离（与旧 cloneJson 语义
   *   一致：丢弃 undefined 字段、断开一切引用），调用方可自由修改；
   * - bytes：同一份文本的 UTF-8 字节数，供体积闸门直接使用。
   *
   * 因此"内容"与"体积测量"同源，不再出现旧实现里「cloneJson 全量克隆 + measureJsonBytes
   * 再 stringify + 闸门内又一次 stringify」的三次全量序列化（审核确认的调度热点），
   * 也不会出现内容与体积来自两次不同序列化的第二事实源。
   *
   * 永不抛异常：正常数据走完整投影；一旦遇到不可 JSON 序列化的负载（循环引用 /
   * BigInt / 抛错 getter，可能来自外部完成句柄），改为记录 budget 违规并返回
   * 只含存活终态的最小安全快照（bytes=null 表示不可测量）——绝不把未处理异常抛给
   * persistence / RPC 路径。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>}} [options] - 透传给 buildSnapshotPayload
   *   的排除集合（显式回收的候选快照）。
   * @returns {{payload:object, bytes:number|null, degraded:boolean}}
   */
  function serializeSnapshotEnvelope(options = {}) {
    try {
      const text = JSON.stringify(buildSnapshotPayload(options));
      return { payload: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8"), degraded: false };
    } catch (error) {
      if (process.env.FANOUT_DEBUG_DEGRADE) console.error("DEGRADE CAUSE:", error && error.stack);
      const violation = describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "serialize",
        hint: "快照含不可 JSON 序列化的负载，已退化为最小安全快照",
      });
      // serialize 阶段：快照含不可 JSON 序列化负载。记录违规并发布 budget_rejected
      // （事件本身只带 violation 元数据，不回显任何快照负载）。
      events.noteBudgetViolation(violation, "serialize");
      console.warn("dsh-expert-group: fan-out snapshot is not JSON-serializable, degraded to minimal snapshot");
      return {
        payload: {
          version: SNAPSHOT_VERSION,
          sequence: ledger.sequenceValue(),
          nextTaskNumber: store.nextTaskNumberValue(),
          processInstance: PROCESS_INSTANCE,
          degraded: true,
          violation,
          tasks: [],
          events: [],
        },
        bytes: null,
        degraded: true,
      };
    }
  }

  /**
   * 可序列化快照（公开出口）：返回与内部状态隔离的深拷贝，永不抛异常。
   *
   * 与落盘路径共用同一个 envelope：内容与体积来自同一次 stringify，degraded 语义也不
   * 会有第二套实现。读路径虽然用不到 bytes，代价只是一次 O(文本长度) 的字节统计，
   * 远小于 stringify/parse 本身。
   */
  function serializeSnapshot() {
    return serializeSnapshotEnvelope().payload;
  }

  return Object.freeze({
    buildSnapshotPayload,
    serializeSnapshotEnvelope,
    serializeSnapshot,
  });
}
