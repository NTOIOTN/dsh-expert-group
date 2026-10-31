/**
 * 稳定错误码字面量的唯一定义处（票据 08）。
 *
 * 为什么需要它：同一批对外可见的稳定 code 原先在多个模块里各写一份字符串字面量
 * （fan-out 闸门、Host 运行时闸门、容量接纳、RPC 传输），任何一处笔误都会让
 * 「同一个语义」在两个调用点变成两个 code——而 code 是客户端、诊断面与测试共同
 * 依赖的契约。本模块按**域**分组，每组一个冻结对象；每个字面值与其拆分前逐字一致，
 * 消费方只改引用来源，不改任何错误处理分支、事件顺序或 RPC 字段。
 *
 * 边界：
 * - 纯常量：无 import、无副作用，可在任何层（fanout/、host/、shared/）被消费。
 * - 只收「跨文件重复出现」的 code；只在一处出现的 code 留在原处，避免无谓搬动。
 * - 浏览器侧（`client-freshness.js` 的 gateway/cancelled）仍是独立字面量：它是
 *   IIFE 装配面，不能 import 服务端 ESM 叶子；`test/error-codes-single-source.test.mjs`
 *   把该例外显式列进白名单，避免它悄悄漂移。
 * - 不要在别处重新硬编码这些字面量：同一测试会扫描产品源码，重复即红。
 *
 * @module dsh-expert-group/shared/error-codes
 */

/**
 * fan-out 任务域（fanout/）。
 *
 * - MANAGER_CLOSED：manager 已 close 之后所有写入口的统一拒绝码。reason 仍然区分
 *   already_closed / manager_closed（那是调用方可读的原因，不是第二个 code）。
 * - INVALID_BUDGET：快照/请求超出预算（tasks / shards / attempts / 字节）时的结构化
 *   拒绝码；Host 的恢复失败分类也依赖它判定「同一份磁盘数据重试不会变好」。
 */
export const FANOUT_ERROR_CODES = Object.freeze({
  MANAGER_CLOSED: "MANAGER_CLOSED",
  INVALID_BUDGET: "INVALID_BUDGET",
});

/**
 * Host 运行时域。
 *
 * RUNTIME_CLOSED：插件运行时已关闭（gate.closed）。此时提交/重试/恢复/cancel 一律
 * 返回它，且不得再入队、不得新建 attempt——它是「运行时生命周期」闸门，与 fan-out
 * 自己的 MANAGER_CLOSED 是两道不同的闸门，不可互相替代。
 */
export const RUNTIME_ERROR_CODES = Object.freeze({
  RUNTIME_CLOSED: "RUNTIME_CLOSED",
});

/**
 * 子代理接纳/容量域。
 *
 * SUBAGENT_CAPACITY_REACHED：DEG 自有稳定码，把宿主的进程内容量耗尽
 * （ACTIVATION_LIMIT_REACHED 等）翻译成可读、可重试的统一身份。识别侧
 * （`shared/capacity-errors.js` 的识别集合）与产出侧
 * （`host/index-admission-batches.js`）必须共用同一字面量：翻译后的错误会再次经过
 * 上层分类，两处不一致就会丢失结构化身份并把容量耗尽误判成普通 admission 失败。
 */
export const ADMISSION_ERROR_CODES = Object.freeze({
  SUBAGENT_CAPACITY_REACHED: "SUBAGENT_CAPACITY_REACHED",
});

/**
 * RPC 传输域（legacy HTTP 与 Connection 两条传输共用同一批 code 身份）。
 *
 * - PAYLOAD_TOO_LARGE：请求体超过允许上限 → 413。
 * - CANCELLED：客户端取消（AbortError / ABORT_ERR）→ 499。沿用 DSH Gateway 的
 *   `gateway/cancelled` 身份，避免客户端把取消误判成可重试的 500 internal。
 * - INTERNAL：未归类的内部错误 → 500；原始错误只记日志，不回传给客户端。
 */
export const RPC_ERROR_CODES = Object.freeze({
  PAYLOAD_TOO_LARGE: "payload-too-large",
  CANCELLED: "gateway/cancelled",
  INTERNAL: "internal",
});
