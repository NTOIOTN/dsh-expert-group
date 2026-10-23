/**
 * fan-out 客户端快照纯函数（归一 / 合并事件 / 能力判定）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-fanout-normalize")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientFanoutNormalize(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-fanout-normalize");

    // ── Fan-out 客户端快照纯函数 ───────────────────────────────────────────
    // 这些函数只处理 JSON 兼容数据，不读取 React/DOM，既可供面板使用也可供契约测试复用。
    const FANOUT_SHARD_STATUS_KEYS = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"];
    const FANOUT_TERMINAL_SHARD_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
    const FANOUT_RETRYABLE_SHARD_STATUSES = new Set(["failed", "timed_out", "cancelled", "interrupted"]);
    const FANOUT_STATUS_LABELS = {
      queued: "排队中",
      running: "运行中",
      succeeded: "成功",
      failed: "失败",
      cancelled: "已取消",
      timed_out: "已超时",
      interrupted: "已中断",
      pending: "等待中",
      completed: "已完成",
      completed_with_errors: "部分失败",
    };

    function fanoutIsObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** 深拷贝 RPC JSON，避免旧快照中的 result/error 被后续事件引用污染。 */
    function cloneFanoutValue(value, seen = new WeakMap()) {
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return seen.get(value);
      if (Array.isArray(value)) {
        const clone = [];
        seen.set(value, clone);
        for (const item of value) clone.push(cloneFanoutValue(item, seen));
        return clone;
      }
      const clone = {};
      seen.set(value, clone);
      for (const key of Object.keys(value)) clone[key] = cloneFanoutValue(value[key], seen);
      return clone;
    }

    function fanoutString(value, fallback = void 0) {
      if (typeof value !== "string") return fallback;
      const text = value.trim();
      return text.length > 0 ? text : fallback;
    }

    function fanoutStatusOf(value, fallback) {
      return fanoutString(value, fallback) ?? fallback;
    }

    function fanoutTimestampOf(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    function fanoutCountOf(value, fallback = 0) {
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    }

    function normalizeFanoutAttempt(rawAttempt, index, fallbackStatus) {
      const source = fanoutIsObject(rawAttempt) ? rawAttempt : {};
      const attempt = Number.isSafeInteger(source.attempt) && source.attempt > 0
        ? source.attempt
        : index + 1;
      const normalized = {
        attempt,
        status: fanoutStatusOf(source.status, fallbackStatus),
      };
      for (const field of ["error", "result", "childId", "messageId"]) {
        if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === void 0) continue;
        normalized[field] = cloneFanoutValue(source[field]);
      }
      return normalized;
    }

    function normalizeFanoutShard(rawShard) {
      if (!fanoutIsObject(rawShard)) return null;
      const shardId = fanoutString(rawShard.shardId);
      if (shardId === void 0) return null;
      const status = fanoutStatusOf(rawShard.status, "queued");
      const attempts = Array.isArray(rawShard.attempts)
        ? rawShard.attempts.map((attempt, index) => normalizeFanoutAttempt(attempt, index, status))
        : [];
      return {
        shardId,
        prompt: typeof rawShard.prompt === "string" ? rawShard.prompt : "",
        status,
        attempts,
      };
    }

    function deriveFanoutCounts(shards) {
      const counts = {};
      for (const key of FANOUT_SHARD_STATUS_KEYS) counts[key] = 0;
      for (const shard of Array.isArray(shards) ? shards : []) {
        if (Object.prototype.hasOwnProperty.call(counts, shard?.status)) counts[shard.status] += 1;
      }
      counts.pending = counts.queued + counts.running;
      return counts;
    }

    function normalizeFanoutCounts(rawCounts, shards) {
      const derived = deriveFanoutCounts(shards);
      const source = fanoutIsObject(rawCounts) ? rawCounts : {};
      const counts = {};
      for (const key of FANOUT_SHARD_STATUS_KEYS) counts[key] = fanoutCountOf(source[key], derived[key]);
      counts.pending = fanoutCountOf(source.pending, counts.queued + counts.running);
      return counts;
    }

    /** 将 Host 快照裁成稳定的、只含面板所需字段的不可变视图。 */
    function normalizeFanoutTask(rawTask) {
      if (!fanoutIsObject(rawTask)) return null;
      const parentTaskId = fanoutString(rawTask.parentTaskId);
      if (parentTaskId === void 0) return null;
      const shards = (Array.isArray(rawTask.shards) ? rawTask.shards : [])
        .map(normalizeFanoutShard)
        .filter((shard) => shard !== null);
      return {
        parentTaskId,
        role: fanoutString(rawTask.role, "unknown"),
        basePrompt: typeof rawTask.basePrompt === "string" ? rawTask.basePrompt : "",
        status: fanoutStatusOf(rawTask.status, "pending"),
        createdAt: fanoutTimestampOf(rawTask.createdAt),
        updatedAt: fanoutTimestampOf(rawTask.updatedAt),
        settledAt: fanoutTimestampOf(rawTask.settledAt),
        counts: normalizeFanoutCounts(rawTask.counts, shards),
        shards,
      };
    }

    function fanoutTaskLabel(task) {
      const role = fanoutString(task?.role, "unknown");
      const parentTaskId = fanoutString(task?.parentTaskId, "unknown");
      return role + " · " + parentTaskId;
    }

    function fanoutStatusLabel(status) {
      return FANOUT_STATUS_LABELS[status] ?? fanoutString(status, "未知状态");
    }

    function fanoutCanCancelShard(shard) {
      const status = typeof shard === "string" ? shard : shard?.status;
      return !FANOUT_TERMINAL_SHARD_STATUSES.has(status);
    }

    function fanoutCanRetryShard(shard) {
      const status = typeof shard === "string" ? shard : shard?.status;
      return FANOUT_RETRYABLE_SHARD_STATUSES.has(status);
    }

    function fanoutCanCancelParent(task) {
      return (Array.isArray(task?.shards) ? task.shards : []).some(fanoutCanCancelShard);
    }

    /** 失败/非契约响应直接返回原 state，保证旧快照不会被错误响应清空或半更新。 */
    function normalizeFanoutListResponse(payload, previousState = { tasks: [], cursor: 0, loaded: false }) {
      const previous = fanoutIsObject(previousState)
        ? previousState
        : { tasks: [], cursor: 0, loaded: false };
      if (payload?.ok !== true || !Array.isArray(payload.tasks)) return previous;
      const tasks = payload.tasks.map(normalizeFanoutTask).filter((task) => task !== null);
      const cursor = Number.isSafeInteger(payload.cursor) && payload.cursor >= 0
        ? payload.cursor
        : fanoutCountOf(previous.cursor, 0);
      return { ...previous, tasks, cursor, loaded: true };
    }

    /**
     * 合并可选 fanout-events 事件。事件只通过 parentTaskId/shardId 定位，绝不按数组下标；
     * 事件字段不完整时保留旧 prompt、attempt 历史，下一次 list 刷新仍是权威快照。
     */
    function mergeFanoutEvent(task, event) {
      const current = normalizeFanoutTask(task);
      if (current === null || !fanoutIsObject(event) || event.parentTaskId !== current.parentTaskId) return current;
      const updates = Array.isArray(event.shards)
        ? event.shards.filter((shard) => fanoutString(shard?.shardId) !== void 0)
        : fanoutString(event.shardId) === void 0 ? [] : [event];
      const updateByShardId = new Map(updates.map((shard) => [fanoutString(shard.shardId), shard]));
      const shards = current.shards.map((shard) => {
        const update = updateByShardId.get(shard.shardId);
        if (!fanoutIsObject(update)) return shard;
        const nextStatus = fanoutStatusOf(update.status, shard.status);
        const attempts = shard.attempts.map((attempt) => ({ ...attempt }));
        const eventAttempt = Number.isSafeInteger(update.attempt) && update.attempt > 0 ? update.attempt : void 0;
        const declaredAttempts = Number.isSafeInteger(update.attempts) && update.attempts >= 0 ? update.attempts : 0;
        if (eventAttempt !== void 0) {
          while (attempts.length < eventAttempt) {
            attempts.push({ attempt: attempts.length + 1, status: "queued" });
          }
          const attemptIndex = attempts.findIndex((attempt) => attempt.attempt === eventAttempt);
          const baseAttempt = attemptIndex >= 0 ? attempts[attemptIndex] : { attempt: eventAttempt, status: nextStatus };
          const mergedAttempt = normalizeFanoutAttempt({ ...baseAttempt, ...update, attempt: eventAttempt, status: nextStatus }, attemptIndex >= 0 ? attemptIndex : attempts.length, nextStatus);
          if (attemptIndex >= 0) attempts[attemptIndex] = mergedAttempt;
          else attempts.push(mergedAttempt);
        }
        while (attempts.length < declaredAttempts) {
          attempts.push({ attempt: attempts.length + 1, status: nextStatus });
        }
        return { ...shard, status: nextStatus, attempts };
      });
      const next = {
        ...current,
        shards,
        counts: normalizeFanoutCounts(event.counts, shards),
        updatedAt: fanoutTimestampOf(event.at) ?? current.updatedAt,
      };
      if (event.type === "task_settled") {
        next.status = fanoutStatusOf(event.status, current.status);
        next.settledAt = fanoutTimestampOf(event.at) ?? current.settledAt;
      } else if (updates.some((update) => update.status === "queued" || update.status === "running")) {
        next.status = "pending";
        next.settledAt = null;
      }
      return normalizeFanoutTask(next);
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    fanoutCanCancelParent, fanoutCanCancelShard, fanoutCanRetryShard, fanoutStatusLabel, fanoutTaskLabel,
    mergeFanoutEvent, normalizeFanoutListResponse, normalizeFanoutTask,
  });
})(globalThis);
