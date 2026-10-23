/**
 * 入口系统通知（Toast）域（R4a · 票据 15）。
 *
 * 这一域只做一件事：把**已经发布的结论**按宿主语言渲染成固定文案，交给 Windows 通知
 * 适配器。它不参与等待、派发或收口：投递失败只记固定类别日志，绝不改变任何快照、
 * admission 或等待语义（ADR 0005 / 票据 11 / 14 / 19）。
 *
 * ## 组合根保留的职责
 * Toast 适配器由入口装配前言域创建，ctx.effect 的释放注册仍留在 index.js 原注册点；
 * 本模块只接收适配器与设置读取面，**不接收 ctx**（票据 15 铁律 1）。
 *
 * ## 晚绑定的设置读取面
 * settingsSource 在入口后段才就绪（storage domain 初始化后重绑），因此这里只接收
 * readSettings() 取值函数；每次投递前读当次值，与迁移前的闭包语义一致。
 *
 * @module dsh-expert-group/host/index-toast
 */
import { resolveHostLocale } from "../shared/i18n.js";
import { normalizeToastVolume } from "./system-toast.js";
import { DEFAULT_NOTIFICATION_VOLUME_SETTING, normalizeNotificationEvents } from "./settings-schema.js";
import {
  buildTerminationNotificationText,
  buildUserWaitNotificationText,
  buildTestNotificationText,
} from "./notification-text.js";

/**
 * 创建系统通知（Toast）通道。
 *
 * @param {object} deps
 * @param {object} deps.config - 插件 Config（读取可注入的 locale / language）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与错误名，绝不复述正文）。
 * @param {object} deps.systemToast - 由装配前言创建的 Toast 适配器（可注入替身）。
 * @param {() => object|undefined} deps.readSettings - settings 读取面的晚绑定取值。
 * @param {() => unknown} deps.readCtxLocale - 宿主 ctx.locale 的安全只读取值（Cordis 对未声明
 *   属性会抛，组合根已用 try/catch 包住；这里只消费结果，绝不接触 ctx 本体）。
 * @returns {object} 通知通道能力面（文案渲染 + 投递 + 平台 token）。
 */
export function createSystemToastChannel({ config, logger, systemToast, readSettings, readCtxLocale }) {
  function systemToastEnabled() {
    try {
      return readSettings()?.notificationEnabled !== false;
    } catch {
      return true;
    }
  }

  /**
   * 系统通知音量：与设置页写的是同一个值（0..100），只缩放 DEG 自己的提示音播放流。
   *
   * 与 systemToastEnabled 同形的安全读取：合法安全整数 0..100 原样返回；缺失、非法
   * （小数/越界/非数字）或读取异常一律回退 100（= 只受系统主音量影响）。读设置失败绝不静音，
   * 也绝不改动 Windows 主音量——音量只是个尽力而为的播放参数，不影响投递语义。
   */
  function systemToastVolume() {
    let value;
    try {
      value = readSettings()?.notificationVolume;
    } catch {
      return DEFAULT_NOTIFICATION_VOLUME_SETTING;
    }
    return normalizeToastVolume(value);
  }

  /**
   * 某一类通知事件当前是否启用（票据 14）。
   *
   * 读取面与投递面共用同一份归一规则：缺失字段/读取异常一律按开启处理（历史行为），
   * 只有显式 false 才跳过。过滤只发生在**投递前**，不改变任何快照、admission 或等待语义；
   * 关闭某一类事件也不会补发历史结论。
   */
  function systemToastEventEnabled(eventType) {
    let events;
    try {
      events = normalizeNotificationEvents(readSettings()?.notificationEvents);
    } catch {
      return true;
    }
    return events[eventType] !== false;
  }

  /**
   * 终止原因到通知事件类别的稳定映射（票据 14）。
   *
   * 只有 completed 归"任务完成"；其余终止原因（blocked/error/max-tokens/aborted/
   * interrupted/unknown）都没有"正常完成"语义，统一归"任务失败"，让用户可以用一个
   * 开关抑制所有非完成终态。未知/扩展 kind 因此也按失败处理，绝不冒充完成。
   */
  function terminationNotificationEventType(reason) {
    return reason === "completed" ? "completed" : "failed";
  }

  /** 失败只记固定类别与错误名：通知正文、命令行与路径绝不出现在日志里。 */
  function logSystemToastFailure(error) {
    const name = typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error";
    logger.warn("dsh-expert-group: system toast delivery failed (" + name + ")");
  }

  /**
   * 发送一次系统通知。
   *
   * 适配器自身绝不抛出（失败收口为固定 reason），这里再兜一层同步异常与 rejected
   * promise：通知失败绝不能影响快照、handoff 或任务语义，也绝不回退成应用内卡片。
   *
   * @param {{title?: string, taskName?: string, body?: string}|null} text - 固定文案对象。
   * @param {"completed"|"waiting"|"failed"|null} [eventType] - 事件类别；null/缺省表示
   *   不走事件过滤（等待账本的健康提示不属于任务完成/等待用户/失败三类）。
   */
  function sendSystemToast(text, eventType = null) {
    if (text === null || text === void 0) return;
    if (systemToastEnabled() !== true) return;
    if (eventType !== null && systemToastEventEnabled(eventType) !== true) return;
    let pending;
    try {
      pending = systemToast.show({
        title: text.title,
        taskName: text.taskName,
        body: text.body,
        // 音量是扁平字段：文案对象仍只有 title/taskName/body，音量不进入通知文本与诊断。
        volume: systemToastVolume(),
      });
    } catch (error) {
      logSystemToastFailure(error);
      return;
    }
    Promise.resolve(pending).catch((error) => { logSystemToastFailure(error); });
  }

  /**
   * 通知文案的宿主语言（票据 19）。
   *
   * 解析顺序：config.locale（组合根可注入）→ 环境 LC_ALL/LC_MESSAGES/LANG → Intl 运行时 locale
   * → 默认 zh。全部不可识别时回退 zh 并由 onFallback 记一条日志（不抛错、不影响通知投递）。
   * 组合期解析一次：语言在进程生命周期内不会变化，逐次通知重读环境只会放大日志与开销。
   */
  /** 安全读一个宿主角色的可选属性：Cordis 对未声明属性会抛，读不到一律当缺失。 */
  const readLocaleCandidate = (target, key) => {
    try { return target?.[key]; } catch { return undefined; }
  };
  const notificationLocale = resolveHostLocale({
    configLocale: readLocaleCandidate(config, "locale")
      ?? readLocaleCandidate(config, "language")
      ?? readCtxLocale(),
    env: (() => { try { return typeof process !== "undefined" ? process.env : {}; } catch { return {}; } })(),
    onFallback: () => {
      try {
        logger?.warn?.("dsh-expert-group: 无法解析宿主语言，通知文案回退默认 zh");
      } catch { /* 日志面不可用不影响通知。 */ }
    },
  });
  /** 终止通知文案：纯构造函数 + 组合期解析出的 locale（见 buildTerminationNotificationText）。 */
  const localizedTerminationToast = (reason, taskName) =>
    buildTerminationNotificationText(notificationLocale, reason, taskName);

  /**
   * 「等待用户」通知文案：只认 host/system-toast 声明过的两种工具名（userWaitToastText 是
   * 同一份判据）；未知工具返回 null，宁可不提示也不编造提示。
   */
  const localizedUserWaitToast = (tool, taskName) =>
    buildUserWaitNotificationText(notificationLocale, tool, taskName);

  /**
   * 系统通知通道的平台分类：固定枚举，绝不复述适配器返回的自由文本。
   * 用于「发送测试通知」回执与诊断面同一套 token（windows / unsupported）。
   */
  function systemToastPlatformToken() {
    try {
      const state = typeof systemToast?.describe === "function" ? systemToast.describe() : null;
      return state?.platform === "windows" ? "windows" : "unsupported";
    } catch {
      return "unsupported";
    }
  }

  /**
   * 「发送测试通知」的文案（票据 14 / 19）。
   *
   * 只描述"这是一条测试通知"，绝不伪造任务完成/失败等状态，也不携带任务名称；
   * 该动作不创建任务、不写快照、不影响等待账本。标题/正文都来自消息表，跟随宿主语言。
   */
  const testNotificationToast = () => buildTestNotificationText(notificationLocale);

  return {
    systemToastEnabled,
    systemToastVolume,
    systemToastEventEnabled,
    terminationNotificationEventType,
    logSystemToastFailure,
    sendSystemToast,
    notificationLocale,
    localizedTerminationToast,
    localizedUserWaitToast,
    systemToastPlatformToken,
    testNotificationToast,
  };
}
