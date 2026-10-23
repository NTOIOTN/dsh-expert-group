/**
 * 组合根顶层的第 S1 段（R1 票据 06）：自 index.js 第 229–278 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { translateMessage } from "../shared/i18n.js";
import { userWaitToastText } from "./system-toast.js";

/**
 * Host 通知文案的纯构造函数（票据 19）。
 *
 * locale 由调用方解析后传入（见 resolveHostLocale），这里只做「固定类别 → 消息表键」的映射，
 * 因此可以在 node:test 里直接注入 zh/en 验证，不需要驱动真实终止事件或桌面通知。
 * 结构契约保持不变：{ title, body, taskName? }，taskName 仍作为独立的第二行。
 */
export function buildTerminationNotificationText(locale, reason, taskName) {
  const raw = typeof reason === "string" ? reason.trim() : "";
  const known = ["completed", "blocked", "error", "aborted", "interrupted", "max-tokens"].indexOf(raw) === -1 ? "unknown" : raw;
  const label = typeof taskName === "string" ? taskName.trim() : "";
  return {
    title: translateMessage(locale, "notify.test.title"),
    body: translateMessage(locale, "notify.termination." + known),
    ...(label.length > 0 ? { taskName: label } : {}),
  };
}

/** 用户等待通知：只认 host/system-toast 声明的两种工具名；未知工具返回 null（宁可不提示）。 */
export function buildUserWaitNotificationText(locale, tool, taskName) {
  const base = userWaitToastText(tool, taskName);
  if (base === null) return null;
  return {
    ...base,
    title: translateMessage(locale, "notify.wait.title"),
    body: translateMessage(locale, "notify.wait.body"),
  };
}

/** 「发送测试通知」文案：只描述通道可用，不伪造任务状态。 */
export function buildTestNotificationText(locale) {
  return {
    title: translateMessage(locale, "notify.test.title"),
    body: translateMessage(locale, "notify.test.body"),
  };
}

/**
 * 等待账本提示文案：固定类别 → 消息表键。
 *
 * 产品收敛后只有「收口结论投递失败」还会提示用户：
 * - `deliveryFailed` → `notify.waitDeliveryFailed.body`（body 里含重试说明）；
 * - `long`（等待 ≥ 30 分钟）与 `queryDegraded`（后代查询降级/失败）的文案已随系统通知
 *   一并删除，两者返回 null。账本侧的定时器、issue 产生与 reminderCount /
 *   capabilityLevel 诊断**不受影响**，只是不再变成用户可见提示。
 * - 其他未知类别同样返回 null（绝不猜测文案）。
 */
export function buildRootWaitNotificationText(locale, kind) {
  if (kind !== "deliveryFailed") return null;
  return {
    title: translateMessage(locale, "notify.test.title"),
    body: translateMessage(locale, "notify.waitDeliveryFailed.body"),
  };
}

