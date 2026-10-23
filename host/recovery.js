/**
 * Host 关注点模块：普通专家自动恢复的 runtime 状态与判定。
 *
 * 接管此前散落在 index.js 的 recovery 上下文存储（原 record.taskRecoveryContexts）、
 * 待消费的重建意图队列（原 pendingRecoveryRebuilds）、失败文案分类、终止性投递
 * 错误分类与恢复预算判定。recovery record 本身仍由组合根持有（被多个事件路径
 * 直接读写），本模块只持有"纯状态 + 纯判定"。
 *
 * 语义保持：自动恢复最多 5 次、成功重置、明确取消不恢复、非空输出不恢复；
 * 不涉及 fan-out 手工 retry。
 *
 * 生命周期（任务 06）：模块暴露 describe()/dispose() 标准形态，可作为生命周期参与者
 * 装配进 host/composition，也可由入口在 ctx.effect 清理里直接调用。dispose 同步关闭
 * 并清空重建意图与上下文存储，随后按注册逆序执行释放回调（timer、AbortController、
 * pending operation、相关绑定），异步回调会被等待；重复 dispose 返回同一个 promise，
 * 回调只执行一次。关闭之后到达的迟到 promise 一律读到空状态：takeRebuild/contextFor/
 * promptFor 为空、canAutoRecover 为 false、queueRebuild 静默丢弃，因此不可能复活任务
 * 或启动新的 child（也不能把错误变成未处理的 rejection）。
 *
 * @module dsh-expert-group/host/recovery
 */
import { appendRecoveryRetryCount } from "../shared/recovery-ledger.js";
import { lastTurnErrorMessage } from "../shared/retry-policy.js";
import { shouldAutoRecover } from "../shared/turn-settlement.js";

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function evictOldest(store, limit) {
  while (store.size > limit) {
    const oldest = store.keys().next();
    if (oldest.done === true) return;
    store.delete(oldest.value);
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.limit] - 自动恢复上限。
 * @param {number} [options.taskBindingLimit] - 每个 record 保留的任务上下文上限。
 * @param {string} [options.effortMarker] - child.options 上的推理深度 marker 名。
 * @param {string} [options.subagentProviderMarker] - child.options 上的目标 subagent
 *   provider marker 名（票据 29）。给出时把本次请求选择的 provider 一并保存进恢复
 *   上下文，供重建路径在持久化记录尚未落地时仍能按原 provider 重建。
 * @param {string} [options.inheritContextMarker] - child.options 上的上下文继承 marker 名
 *   （票据 29）。只有布尔 true 才记为继承型；缺失/false 记为普通 spawn。
 * @param {Function[]} [options.disposeHooks] - 释放回调（timer 清理、AbortController
 *   取消、pending operation 与绑定释放）；按注册逆序执行，异步回调会被等待。
 */
export function createRecoveryModule({
  limit = 5,
  taskBindingLimit = 64,
  effortMarker = "__degExpertEffort",
  subagentProviderMarker = void 0,
  inheritContextMarker = void 0,
  disposeHooks = [],
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("recovery limit 必须是非负整数");
  if (!Number.isSafeInteger(taskBindingLimit) || taskBindingLimit <= 0) throw new TypeError("taskBindingLimit 必须是正整数");
  if (!Array.isArray(disposeHooks) || disposeHooks.some((hook) => typeof hook !== "function")) {
    throw new TypeError("disposeHooks 必须全部是函数");
  }
  let contexts = new WeakMap();
  let contextCount = 0;
  const rebuilds = [];
  // 释放回调按注册顺序保存、按注册逆序执行；dispose 时整体摘除，保证每个回调只跑一次。
  const hooks = disposeHooks.slice();
  let disposed = false;
  let disposePromise;

  const api = {
    /**
     * 保存恢复重建所需的原任务上下文：route、prompt、provider/model/effort、
     * persona、toolFilter 与 maxDepth。非文本 prompt 不建立上下文。
     */
    rememberContext(record, { routeKey, request, label, taskKey } = {}) {
      if (disposed || !isRecord(record) || request === void 0 || request === null) return undefined;
      const promptText = request.prompt?.[0]?.text;
      if (typeof promptText !== "string" || promptText.length === 0) return undefined;
      // 目标 subagent provider（票据 29）：优先取请求上的内部字段（调用方在组装
      // 请求时写入），其次取同源 agentOptions marker。重建路径只把它当作持久化
      // child_models 记录缺失时的兜底，绝不在这里重新做选择。
      const markerProvider = typeof subagentProviderMarker === "string"
        ? request.agentOptions?.[subagentProviderMarker]
        : void 0;
      const targetProvider = typeof request.subagentProvider === "string" && request.subagentProvider.length > 0
        ? request.subagentProvider
        : (typeof markerProvider === "string" && markerProvider.length > 0 ? markerProvider : void 0);
      const inheritContext = typeof inheritContextMarker === "string"
        && request.agentOptions?.[inheritContextMarker] === true;
      const context = {
        routeKey,
        label,
        promptText,
        provider: request.agentOptions?.provider,
        model: request.agentOptions?.model,
        reasoningEffort: request.agentOptions?.[effortMarker],
        persona: request.persona,
        toolFilter: request.toolFilter,
        maxDepth: request.maxDepth,
        // 缺失时省略而不是写 undefined，保持旧恢复上下文的形状不变（旧记录不受影响）。
        ...(targetProvider === void 0 ? {} : { subagentProvider: targetProvider }),
        ...(inheritContext === true ? { inheritContext: true } : {}),
      };
      let store = contexts.get(record);
      if (store === undefined) {
        store = new Map();
        contexts.set(record, store);
        contextCount += 1;
      }
      // routeKey 与 recoveryRequest 是既有 record 字段（重建路径会读 route 变化），
      // 继续写回以保持兼容；按任务键的查找由本模块持有。
      record.routeKey = routeKey;
      record.recoveryRequest = context;
      store.set(taskKey, context);
      evictOldest(store, taskBindingLimit);
      return context;
    },
    /** 优先按 op.taskKeys 取本次任务的上下文，缺失时回落最近一次上下文。 */
    contextFor(record, op) {
      // 关闭之后连宿主持有的兼容字段（record.recoveryRequest）也不再读取：迟到的恢复
      // 流程不能借它复活 prompt。
      if (disposed) return undefined;
      const store = isRecord(record) ? contexts.get(record) : undefined;
      if (store !== undefined) {
        for (const taskKey of op?.taskKeys ?? []) {
          const context = store.get(taskKey);
          if (context !== undefined) return context;
        }
      }
      return record?.recoveryRequest;
    },
    promptFor(record, op) {
      const context = api.contextFor(record, op);
      return typeof context?.promptText === "string" ? context.promptText : void 0;
    },

    /** 登记一个待消费的重建意图（agent/created 时按 parent+parentId+role 取用）。 */
    queueRebuild(entry) {
      // 关闭后重新排队是"迟到 promise"最常见的复活入口：静默丢弃。这里不能抛错，
      // 否则迟到回调会把异常变成未处理的 rejection。
      if (disposed) return undefined;
      if (!isRecord(entry) || typeof entry.parentId !== "string" || typeof entry.role !== "string") {
        throw new TypeError("queueRebuild 需要 parentId/role");
      }
      rebuilds.push(entry);
      return entry;
    },
    /** 取用并移除最早匹配的重建意图；父 Agent 必须是同一 exact 对象。 */
    takeRebuild(parent, parentId, role) {
      const index = rebuilds.findIndex((item) => item.parent === parent && item.parentId === parentId && item.role === role);
      return index === -1 ? void 0 : rebuilds.splice(index, 1)[0];
    },
    /** 移除一个具体的重建意图（startContinuable 失败/成功后清理）。 */
    removeRebuild(entry) {
      const index = rebuilds.indexOf(entry);
      if (index === -1) return false;
      rebuilds.splice(index, 1);
      return true;
    },
    dropRebuildsFor(parent) {
      let removed = 0;
      for (let index = rebuilds.length - 1; index >= 0; index -= 1) {
        if (rebuilds[index].parent === parent) {
          rebuilds.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    rebuildsFor: (parent) => rebuilds.filter((item) => item.parent === parent),
    rebuildCount: () => rebuilds.length,

    /** 失败原因文案：底层原因 + 恢复次数后缀（供任务终态与后续 feedback）。 */
    failureMessage(record, reason, session) {
      const kind = reason?.kind;
      let message;
      if (kind === "error") {
        const detail = reason?.error?.message;
        if (typeof detail === "string" && detail.length > 0) {
          message = "subagent run failed: " + detail;
        } else {
          const latest = lastTurnErrorMessage(session?.events);
          message = latest === null ? "subagent run failed" : "subagent run failed: " + latest;
        }
      } else if (kind === "aborted") {
        message = "subagent run was cancelled";
      // B9：blocked（pre-step 拒绝，消息被认领但未落盘）与 refusal 统一为 declined 文案。
      } else if (kind === "refusal" || kind === "blocked") {
        message = "subagent declined the task";
      } else if (kind === "max-tokens") {
        message = "subagent run hit its token limit before finishing";
      } else if (kind === "completed") {
        message = "subagent returned no text output";
      } else {
        message = "subagent run ended abnormally (" + String(kind ?? "unknown") + ")";
      }
      return appendRecoveryRetryCount(message, record?.recoveryCount);
    },

    /** 终止性投递错误：取消、权限、父/根生命周期变化不再消耗恢复预算。 */
    isTerminalDispatchError(error) {
      const code = typeof error?.code === "string" ? error.code.toUpperCase() : "";
      const detail = error instanceof Error ? error.message : String(error ?? "");
      if (error?.name === "AbortError"
        || ["ABORT_ERR", "UNAUTHORIZED", "FORBIDDEN", "PERMISSION_DENIED", "DRAINING", "PARENT_DISPOSED", "ROOT_DISPOSED"].includes(code)) {
        return true;
      }
      return /root generation is no longer live|parent.*(?:destroyed|disposed|not live|不可用)|cannot rebuild recovery child because|cancel(?:led|ed)|unauthori[sz]ed|permission denied|forbidden/i.test(detail);
    },

    /** 归一化后的连续恢复次数（非法值按 0）。 */
    recoveryCount(record) {
      return Number.isSafeInteger(record?.recoveryCount) && record.recoveryCount >= 0 ? record.recoveryCount : 0;
    },
    /** 是否仍有自动恢复预算：非空输出、明确取消、超限都返回 false。 */
    canAutoRecover(record, reason, hasOutput) {
      // 卸载之后不得再派发新的恢复 child：预算一律为 0。
      if (disposed) return false;
      return shouldAutoRecover(reason, hasOutput, api.recoveryCount(record)) && api.recoveryCount(record) < limit;
    },
    /** 成功完成后重置连续恢复预算。 */
    resetBudget(record) {
      if (isRecord(record)) record.recoveryCount = 0;
      return 0;
    },
    describe: () => ({ rebuilds: rebuilds.length, trackedContexts: contextCount, disposed }),
    /**
     * 注册一个释放回调：timer 清理、AbortController 取消、pending operation 与绑定
     * 释放都通过它挂到模块生命周期上。关闭之后注册被拒绝（返回 false），避免回调
     * 在关闭之后才登记而永远不执行。
     */
    addDisposeHook(hook) {
      if (typeof hook !== "function") throw new TypeError("addDisposeHook 需要函数");
      if (disposed) return false;
      hooks.push(hook);
      return true;
    },
    /**
     * 幂等清理：同步关闭并清空重建意图与上下文存储（迟到 promise 因此读不到任何状态），
     * 随后按注册逆序执行释放回调。异步回调会被等待，单个回调的异常记录下来后继续
     * 执行其余回调，绝不向外抛出，也不会成为未处理的 rejection。重复调用返回同一个
     * promise，回调只执行一次。
     */
    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      rebuilds.length = 0;
      contexts = new WeakMap();
      contextCount = 0;
      const registered = hooks.splice(0, hooks.length);
      disposePromise = (async () => {
        const errors = [];
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          try {
            const result = registered[index]();
            // 同步回调不额外让出微任务：卸载路径上的 timer/AbortController 立即释放。
            if (result !== null && typeof result === "object" && typeof result.then === "function") await result;
          } catch (error) {
            errors.push(error);
          }
        }
        return Object.freeze({ errors: Object.freeze(errors) });
      })();
      return disposePromise;
    },
  };
  return Object.freeze(api);
}
