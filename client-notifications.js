/**
 * 客户端通知模块（已收缩为占位：客户端不再投递任何通知）。
 *
 * 用户要求：**系统通知是唯一通知界面**——由 Host 在 Windows 右下角弹 Toast（其它应用在前台、
 * DSH 在后台时同样可见），客户端不再承担任何投递职责。因此本模块不再提供：
 *
 * - 页面内卡片/弹窗（历史 ADR 0004 的弹窗桥与其 CSS、aria 契约已整体移除）；
 * - 浏览器通知构造器（客户端不得再次创建系统通知）；
 * - 通知快照的主动轮询（该只读 RPC 仍由 Host 提供，供其它契约与诊断使用，
 *   但客户端不再读取它，也不再据此推导通知）。
 *
 * 文件本身仍留在拼接顺序与 package.json 的 files 白名单里（都由 assembler/发布清单引用），
 * 因此保留"登记一个惰性命名空间"的最小形态：任何仍按旧 Symbol 读取的实现只会拿到一个显式
 * 声明"客户端不投递"的冻结对象，绝不会意外恢复投递能力，也不会在读不到该 Symbol 时抛错。
 *
 * @module dsh-expert-group/client-notifications
 */
(function installClientNotifications(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-notifications");
  // 幂等：同一页面重复求值（打包器重复内联、测试重复 import）不覆盖已有命名空间。
  const existing = global[SYMBOL];
  if (existing !== undefined && existing !== null) return;

  global[SYMBOL] = Object.freeze({
    /** 交付责任归属：只有 Host 会投递（Windows 右下角系统 Toast）。 */
    delivery: "host-system-toast",
    /** 客户端是否具备投递能力：恒为 false（测试与诊断据此断言"客户端不投递"）。 */
    canDeliver: false,
    /** 被移除的投递面清单：读代码的人不必猜哪些能力"本来有"，这里显式列出。 */
    removedCapabilities: Object.freeze([
      "in-page-popup",
      "browser-notification",
      "notification-snapshot-polling",
    ]),
  });
})(globalThis);
