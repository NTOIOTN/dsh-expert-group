/**
 * 组合根顶层的第 S2 段（R1 票据 06）：自 index.js 第 279–395 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

/**
 * 为 RPC 请求创建可传给公开 subagents.startContinuable 的 AbortSignal。
 * 请求 body 读完后仍保留响应断开监听；正常完成时由 handleRpc 的 finally 移除监听。
 */
export function createRpcRequestLifecycle(req, res) {
  const controller = new AbortController();
  let disposed = false;
  const removers = [];
  const abort = () => {
    if (!disposed && !controller.signal.aborted) controller.abort();
  };
  const listenOnce = (target, event, handler) => {
    if (!target || typeof target.once !== "function") return;
    target.once(event, handler);
    removers.push(() => {
      if (typeof target.removeListener === "function") target.removeListener(event, handler);
      else if (typeof target.off === "function") target.off(event, handler);
    });
  };
  if (req?.aborted === true) abort();
  if (res?.destroyed === true) abort();
  listenOnce(req, "aborted", abort);
  listenOnce(req, "error", abort);
  listenOnce(req, "close", () => {
    // close 也会在正常 body 完成后触发；只有未完整解析或明确 aborted 才取消。
    if (req?.aborted === true || req?.complete !== true) abort();
  });
  listenOnce(res, "error", abort);
  listenOnce(res, "close", () => {
    // writableFinished 表示响应已经正常写完；否则是客户端提前断开。
    if (res?.writableFinished !== true) abort();
  });
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of removers.splice(0)) remove();
    },
  };
}

export function createAbortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * 图片路由在异步边界上的 fail-fast：请求级 signal 已取消时立即抛出取消错误。
 *
 * 用于 normalize、能力查询前后、route claim 校验前后与 Observer admission 前后 ——
 * 取消必须保持 AbortError/ABORT_ERR 身份，由 mapRpcError 统一映射为 499
 * gateway/cancelled，绝不能被"能力查询失败保持 unknown"之类的兜底吞掉。
 * @param {AbortSignal|undefined} signal - 请求级取消信号。
 */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw createAbortError();
}

/**
 * 把一次异步失败归一成取消错误（若它属于取消）。
 *
 * `llm.resolveModelInfo` 等适配器可能抛出 AbortError/ABORT_ERR，也可能在 signal 已取消
 * 时抛出普通错误；两种都必须按取消处理。返回 undefined 表示"这是真正的非取消失败"，
 * 调用方可以继续按 unknown/main-first 兜底。
 * @param {unknown} error - 被捕获的异常。
 * @param {AbortSignal|undefined} signal - 请求级取消信号。
 * @returns {Error|undefined} 归一后的取消错误，或 undefined。
 */
export function abortErrorFor(error, signal) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return error;
  return signal?.aborted === true ? createAbortError() : void 0;
}

/**
 * 判断 remote GoalService 的返回值是否为 thenable。
 *
 * shared.js 的 handoff helper 允许 service 返回 Promise 或同步结果，组合根需要在
 * 决定「等待 / 直接读结果」前做同一判定；损坏 adapter 的 then getter 也按不可兼容的
 * 异步服务处理（fail closed，绝不假装同步成功）。
 */
function isThenable(value) {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
  } catch {
    return true;
  }
}

/**
 * 等待 request fallback 的公开退避窗口。只监听 payload.signal，并在 timer 到期时
 * 再检查 Agent/Session 代次；dispose/replacement 不会把已失效 Agent 伪装成 retry 成功。
 */
export function waitForRequestRetryDelay(delay, signals, isActive) {
  const setTimeoutFn = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout : void 0;
  const clearTimeoutFn = typeof globalThis.clearTimeout === "function" ? globalThis.clearTimeout : void 0;
  const signalList = Array.isArray(signals) ? signals.filter((signal) => signal !== void 0 && signal !== null) : [];
  if (!Number.isSafeInteger(delay) || delay <= 0 || signalList.some((signal) => signal.aborted === true) || !isActive()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      for (const signal of signalList) signal.removeEventListener?.("abort", onAbort);
      resolve(ready === true);
    };
    const onAbort = () => finish(false);
    for (const signal of signalList) signal.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeoutFn(() => finish(signalList.every((signal) => signal.aborted !== true) && isActive()), delay);
    if (settled && typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  });
}

