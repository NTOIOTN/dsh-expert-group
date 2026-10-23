/**
 * 子代理容量错误的结构化识别。
 *
 * 容量错误的稳定 code 集合、消息模板、识别（含 assumeCapacity 边界）与构造。
 * 本文件由原 `shared.js` 的 1684–1795 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/capacity-errors
 */

/**
 * 子代理容量耗尽的稳定错误码（DSH 0.1.7-alpha.2 新增的进程内容量上限）。
 *
 * 宿主用一套 `maxActiveSubagents` 名额约束「共享不间断 continuable 父链」的存活 child
 * 数量；名额耗尽时**接纳不排队**（等待后代的父代理不能又等自己占用的名额），
 * 直接拒绝新的新建/冷恢复。
 *
 * 同一语义会以**两种形态**到达 DEG，必须都覆盖：
 * - `ACTIVATION_LIMIT_REACHED`：进程内公开服务（startContinuable / sendMessage 的冷恢复、
 *   重建路径）抛出的原始码；
 * - `subagent/delivery-unavailable`：宿主 Remote 控制面（浏览器 prompt / interrupt）
 *   把 DRAINING / ACTIVATION_CLOSING / **ACTIVATION_LIMIT_REACHED** /
 *   CONTINUATION_UNAVAILABLE / PERSISTENCE_UNAVAILABLE 统一折叠后的包装码。
 *
 * 列表里还包含 DEG 自己的 `SUBAGENT_CAPACITY_REACHED`：翻译后的错误可能再次经过
 * 上层分类（例如 steer 抛给工具 admission 分类），识别必须**幂等**，否则已翻译的
 * 容量错误会在第二次判定时丢失结构化身份。
 *
 * ⚠ `subagent/delivery-unavailable` **不是**容量专属：它还覆盖 DRAINING 等不可回落
 * 情形，因此它只在「调用点上下文已排除排空/权限语义」时才按容量处置（见
 * {@link isSubagentCapacityError} 的 `assumeCapacity` 选项），绝不单独作为回落依据。
 */
export const SUBAGENT_CAPACITY_ERROR_CODES = Object.freeze([
  "ACTIVATION_LIMIT_REACHED",
  "SUBAGENT_CAPACITY_REACHED",
]);

/**
 * 容量耗尽时面向用户的可读提示。
 *
 * 语义与宿主发布说明一致：等待子代理完成，或继续使用现有子代理。刻意不写死具体名额
 * 数值——默认值（8）是宿主配置项，可被用户改，写死会立刻过期。也不回显原始错误码。
 */
export const SUBAGENT_CAPACITY_MESSAGE =
  "已达到同时运行的子代理数量上限；请等待现有子代理完成，或继续使用当前已有的子代理";

/**
 * 判断错误是否表示子代理容量耗尽（纯函数）。
 *
 * 只接受结构化 code 的**精确**匹配：`ACTIVATION_LIMIT_REACHED` 是原始码；
 * `subagent/delivery-unavailable` 只有在调用方显式声明该上下文已排除排空/权限
 * 语义时才按容量处置（`options.assumeCapacity === true`），否则返回 false，
 * 避免把 DRAINING 之类的不可回落错误伪装成可等待。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - `{assumeCapacity}`：该调用点是否已排除非容量语义。
 * @returns {boolean} 容量耗尽返回 true。
 */
export function isSubagentCapacityError(error, options = {}) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (SUBAGENT_CAPACITY_ERROR_CODES.includes(code)) return true;
  return options?.assumeCapacity === true && code === "subagent/delivery-unavailable";
}

/**
 * 把容量耗尽错误翻译成面向用户的可读结果（纯函数）。
 *
 * 返回 `{ code, message, retryable }`：容量耗尽是**可重试**的暂态条件（等某个子代理
 * 结束后同一请求即可成功），因此 `retryable` 为 true，供调用方决定是否保留重试预算。
 * 非容量错误返回 undefined，调用方据此保持既有上抛/重建语义。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - 透传给 {@link isSubagentCapacityError}。
 * @returns {{code:string, message:string, retryable:boolean}|undefined}
 */
export function describeSubagentCapacityFailure(error, options = {}) {
  if (!isSubagentCapacityError(error, options)) return undefined;
  return {
    // 稳定的自有 code：不转发宿主原始码，避免调用方重新依赖已折叠的宿主细节。
    code: "SUBAGENT_CAPACITY_REACHED",
    message: SUBAGENT_CAPACITY_MESSAGE,
    retryable: true,
  };
}

/**
 * 构造一个携带 DEG 自有稳定 code 的容量耗尽错误。
 *
 * 用于「向用户抛出可读提示」的调用点：既保留结构化 code（供上层分类表识别并保持
 * 可重试语义），又不把宿主原始错误码/英文文案泄漏到用户可见文本里。非容量错误
 * 返回 undefined，调用方据此保持原样上抛。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - 透传给 {@link isSubagentCapacityError}。
 * @returns {Error|undefined}
 */
export function createSubagentCapacityError(error, options = {}) {
  const described = describeSubagentCapacityFailure(error, options);
  if (described === undefined) return undefined;
  const capacityError = new Error(described.message);
  capacityError.name = "SubagentCapacityError";
  capacityError.code = described.code;
  capacityError.retryable = described.retryable;
  return capacityError;
}

/**
 * 判断 ordinary interrupt 失败后是否可以安全继续 manager sendMessage（纯函数）。
 * 只有目标 Activation 已进入关闭/不可恢复状态时才回落；这类失败表示 live
 * direct cancel 已失去意义，manager sendMessage 仍可负责 cold admission。
 * UNAUTHORIZED（父 authority/lineage 不匹配）、DRAINING、AbortError、容量耗尽
 * 与未知错误必须原样抛出，不能把权限、取消或容量错误伪装成成功回落——
 * 容量耗尽时 sendMessage 的冷恢复同样会被拒绝，回落只会立刻再次失败。
 * @param {object} [error] - interrupt 抛出的错误。
 * @returns {boolean} 允许继续 sendMessage 时返回 true。
 */
export function interruptFailureCanFallback(error) {
  if (isSubagentCapacityError(error)) return false;
  return error?.code === "ACTIVATION_CLOSING" || error?.code === "NOT_RESUMABLE";
}
