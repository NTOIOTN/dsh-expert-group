/**
 * 入口 agent/request-error 事件接线域（R4e · 票据 19）。
 *
 * 这是 `ctx.on("agent/request-error")` 的纯 handler：在公开 waterfall 上接管插件
 * root / 专家 child / fan-out 分片的模型失败，按三个触发点决定「重试、换候选、终态」：
 * 1. 确定性失败（模型不存在/无 adapter/鉴权失败/上下文超限）→ 有候选立即换，不浪费预算；
 * 2. Host retryPolicy 声明归它管理但已拒绝/耗尽重试 → 换候选；
 * 3. 插件自己的请求级预算（AUTO_RECOVERY_LIMIT）耗尽 → 换候选。
 * 三者都只在「存在下一个候选且总降级次数未超 fallbackLimit」时生效；否则保持原有
 * exhausted/终态语义。取消（signal aborted）永不降级。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册事件：`ctx.on("agent/request-error", handler, { prepend: true })`
 * 的注册（含 prepend 选项与顺序）仍由 `index.js` 在原注册点执行。
 *
 * ## 状态唯一 owner
 * 请求级重试状态 / 模型候选链 / exhausted 标记全部由恢复域持有；本模块只调用其
 * 命令（requestRetryStateFor / switchToNextModelCandidate 等），不持容器。
 *
 * @module dsh-expert-group/host/index-agent-request-error
 */
import {
  AUTO_RECOVERY_LIMIT,
} from "../shared/recovery-ledger.js";
import {
  markRequestRetryEvent,
  isTransientRequestFailure,
  recoveryDelayForCount,
  requestRetryPolicyCoversFailure,
} from "../shared/retry-policy.js";
import { isDeterministicModelFailure } from "../shared/model-route.js";
import { waitForRequestRetryDelay } from "./rpc-request-lifecycle.js";

/**
 * 创建 agent/request-error handler。
 *
 * @param {object} deps - 窄能力面（2 组）。
 * @param {object} deps.logger - 宿主 logger（下游 listener 异常只记消息）。
 * @param {object} deps.recovery - 恢复域的请求级状态面：requestRetryStateFor、
 *   requestFallbackTarget、modelFallbackChainFor、currentModelRouteOf、
 *   switchToNextModelCandidate、hostRetryCountFor、requestRetryStateIsCurrent、
 *   isRequestRetryState。
 * @returns {{handleAgentRequestError: (payload: object, next: Function) => Promise<*>*}} handler。
 */
export function createAgentRequestErrorHandler({ logger, recovery }) {
  /**
   * 在公开 agent/request-error waterfall 上接管插件 root / 专家 child / fan-out
   * 分片的模型失败。使用 prepend 保证该边界先于 Host listener：Host 已有 llm/retry
   * 负责退避时只复用其返回值；Host 未处理的 code 由公开 async hook 使用
   * payload.signal 等待有界退避。这里绝不调用 prompt、私有 steer 或内部 API。
   *
   * @param {object} payload - 宿主事件载荷（agent/failure/turn/step/signal/retryPolicy）。
   * @param {Function} next - 下一个 listener。
   * @returns {Promise<*>>} 透传结果或 { kind: "retry" }。
   */
  async function handleAgentRequestError(payload, next) {
    const agent = payload?.agent;
    const target = recovery.requestFallbackTarget(agent);
    if (target === void 0) return typeof next === "function" ? next() : void 0;
    const session = agent?.session;
    const turn = payload?.turn;
    const step = payload?.step;
    if (session === null || (typeof session !== "object" && typeof session !== "function")
      || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return void 0;

    const state = recovery.requestRetryStateFor(agent, session, turn, step);
    // 候选链惰性构建：没有角色（root/未知 child）、没有候选或读源失败时返回 undefined，
    // 后续所有 switchToNextModelCandidate 调用都会直接返回 false，等价于「不降级」。
    const fallbackChain = recovery.modelFallbackChainFor(agent, target);
    const currentRoute = recovery.currentModelRouteOf(agent, fallbackChain);
    // 是否存在运行期候选链（primary 之外还有可尝试的候选）。它同时决定预算归属：
    // 有候选时由插件管理「每个模型 5 次」；没有候选时保持 Host 预算与既有终态语义。
    const fallbackManaged = fallbackChain !== void 0 && fallbackChain.plan.length > 1;
    // 预算按「当前模型 provider」统计（仅非候选链路径使用）：durable llm/retry 事件
    // 只有 provider 字段，无法区分同一 provider 下的不同模型。
    const budgetProvider = currentRoute?.provider
      ?? (typeof payload?.provider === "string" && payload.provider.length > 0 ? payload.provider : void 0);
    // P1-1：候选链存在（fallbackManaged）时，每个模型的重试预算由插件**本地**计数，
    // 绝不从 session 级 durable 事件恢复——否则同 provider 的新候选会继承前一个模型
    // 已消耗的 5 次重试，切过去立刻被视为耗尽。没有候选链的 root/child 保持既有语义
    // （从宿主事件恢复，尊重 Host maxRetries 的权威性）。
    if (fallbackManaged !== true) {
      const hostCount = recovery.hostRetryCountFor(session, turn, step, budgetProvider);
      if (hostCount > state.retryCount) state.retryCount = Math.min(hostCount, AUTO_RECOVERY_LIMIT);
    }
    const failure = payload?.failure;
    if (state.exhausted === true) return void 0;
    if (markRequestRetryEvent(state, payload, failure)) return void 0;

    // 同一 open step 不应并发处理两次错误；真正的下一次请求会在本 hook
    // 返回后才由 agent loop 发起，因此 activeKey 释放后仍可继续消耗预算。
    const activeKey = String(turn) + ":" + String(step);
    if (state.activeKey === activeKey) return void 0;
    state.activeKey = activeKey;
    try {
      if (payload?.signal?.aborted === true) {
        if (state.retryCount > 0) state.exhausted = true;
        return void 0;
      }
      if (isDeterministicModelFailure(failure)) {
        // 确定性失败：重试必然复现，有候选就立即换模型，不浪费当前模型的预算。
        if (recovery.switchToNextModelCandidate(agent, target, state)) return { kind: "retry" };
        if (fallbackManaged === true) {
          // P1-2：候选链存在但已无下一候选（含降级预算耗尽）——这是整条链的终态。
          // 必须显式置 exhausted：MODEL_NOT_FOUND / NO_ADAPTER 等可重试码不在 turn
          // 永久错误码表里，若不置位，turn/end 的 requestRetryExhausted 为 false，
          // 一次不可恢复的模型失败会被当成可恢复失败继续自动续跑。
          state.exhausted = true;
          return void 0;
        }
        // 没有候选链的 root/child：保留既有语义——可重试码继续走下面的预算路径，
        // 不可重试码由下面的终态分支收口（不在此处改变公共行为）。
      }
      if (!isTransientRequestFailure(failure)) {
        // 已经发生过请求级重试后又出现永久/未知失败时，不能再落入 child
        // continuation，把同一失败计两遍；没有前置请求重试则保留既有终态语义。
        if (state.retryCount > 0) state.exhausted = true;
        return void 0;
      }

      const hostOwnsCode = requestRetryPolicyCoversFailure(payload?.retryPolicy, failure);
      let delegated;
      // 候选链存在时，当前模型的 5 次预算由插件兜底：预算已耗尽就不再委托 Host
      // （mode:"always" 的 retryPolicy 会无限重试，跳过委托才能在预算边界换模型）。
      // 没有候选链的 child 完全保持既有委托语义，绝不改变 Host maxRetries 的权威性。
      const skipDelegation = fallbackManaged === true && state.retryCount >= AUTO_RECOVERY_LIMIT;
      if (typeof next === "function" && skipDelegation !== true) {
        try {
          delegated = await next();
        } catch (error) {
          // 下游 Host listener 的异常不改变 failure.code 的 fail-closed 边界；
          // 只要当前 Agent/Session 仍然存活，就继续使用本插件的最小预算。
          logger.warn("dsh-expert-group: request retry downstream listener failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      const currentTarget = recovery.requestFallbackTarget(agent);
      if (currentTarget === void 0 || !recovery.isRequestRetryState(agent, state)
        || state.session !== session || payload?.signal?.aborted === true) return void 0;

      if (delegated?.kind === "retry") {
        // Host 已完成 durable llm/retry 记录与退避；只同步总预算，绝不再发第二次。
        // 候选链：本地 +1（不从宿主事件恢复，避免继承同 provider 前一个模型的计数）；
        // 非候选链：保留「取本地与宿主事件较大值」的既有语义。
        const hostRetry = fallbackManaged === true ? 0 : recovery.hostRetryCountFor(session, turn, step, budgetProvider);
        state.retryCount = Math.min(Math.max(state.retryCount + 1, hostRetry), AUTO_RECOVERY_LIMIT);
        return delegated;
      }

      if (hostOwnsCode && fallbackManaged !== true) {
        // retryPolicy 明确声明该 code 归 Host 管理时，undefined 表示 Host
        // 已拒绝/耗尽 retry；没有候选链时插件不得补发 action 突破 Host maxRetries
        // （既有语义，root 与「未配置候选」的 child 行为完全不变）。
        // 有候选链时预算由插件自己管理（见下面的预算分支），因此不在这里终态化。
        state.exhausted = true;
        return void 0;
      }

      const nextRetry = state.retryCount + 1;
      if (!Number.isSafeInteger(nextRetry) || nextRetry > AUTO_RECOVERY_LIMIT) {
        // 当前模型的 5 次预算耗尽：有候选就切换，让 loop 用新 route 重发；
        // 候选链也耗尽时保持原有语义（exhausted 阻止自动恢复，并原样上抛失败）。
        if (recovery.switchToNextModelCandidate(agent, target, state)) return { kind: "retry" };
        state.exhausted = true;
        return void 0;
      }
      const providerDelay = Number.isSafeInteger(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
        ? failure.providerRetryAfterMs
        : Number.isSafeInteger(failure?.retryAfterMs) && failure.retryAfterMs > 0
          ? failure.retryAfterMs
          : void 0;
      const delay = providerDelay !== void 0
        ? Math.min(providerDelay, recoveryDelayForCount(nextRetry) ?? providerDelay)
        : recoveryDelayForCount(nextRetry);
      if (!Number.isSafeInteger(delay) || delay <= 0) {
        state.exhausted = true;
        return void 0;
      }
      const generation = state.generation;
      const waitController = new AbortController();
      state.waitController = waitController;
      const active = () => recovery.requestRetryStateIsCurrent(agent, session, turn, step, state, generation);
      const ready = await waitForRequestRetryDelay(delay, [payload?.signal, waitController.signal], active);
      if (state.waitController === waitController) state.waitController = void 0;
      if (!ready || !active()) {
        if (recovery.isRequestRetryState(agent, state) && state.generation === generation) state.exhausted = true;
        return void 0;
      }
      state.retryCount = nextRetry;
      return { kind: "retry" };
    } finally {
      if (state.activeKey === activeKey) state.activeKey = void 0;
    }
  }

  return { handleAgentRequestError };
}
