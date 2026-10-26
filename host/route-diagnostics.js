/**
 * 跨层回退的进程内只读诊断（票据 06）。
 *
 * ## 为什么单独一个模块
 * 「最近一次跨层回退」是**进程内单值**，不跨重启持久化：它回答的是「本进程里时段层是不是
 * 刚刚掉到普通层、为什么掉」。写入点在**路由**（派发期时段层缺配直接跨层、运行期时段层
 * 耗尽切普通层），读出面在**诊断投影**（`diagnostics.fanout.route.lastOrdinaryFallback`），
 * 两者都不该互相 import，因此把这条单值收口到本模块。
 *
 * ## 边界（安全 + 语义）
 * - 只记录稳定事实：会话侧角色 id、fromTier/toTier、稳定原因码与时间戳；**绝不记录**
 *   prompt、任务正文、错误 message、候选清单（provider/model）或凭据；
 * - 字段 sanitize：角色 id 与原因码都去除控制字符并限长（角色名属公开配置，不做字符白名单，
 *   以免自定义角色在诊断里静默消失）；原因码只接受稳定 token 形态，否则显式为 null；
 * - 覆盖语义：只保留**最近一次**（后写覆盖先写），不做计数、不保留历史，因此诊断面大小恒定；
 * - 纯 state 单值 + 两个只读/写入命令：不读 settings、不读时钟（`at` 只用于新鲜度，
 *   缺失时取墙钟），也绝不参与任何业务判定。
 *
 * @module dsh-expert-group/host/route-diagnostics
 */

/** 角色 id 在诊断面里的长度上限（与 provider 名的 64 字符口径一致）。 */
export const ROUTE_DIAGNOSTIC_ROLE_MAX_LENGTH = 64;
/** 稳定原因码的长度上限（现有原因码远短于该值）。 */
export const ROUTE_DIAGNOSTIC_CODE_MAX_LENGTH = 64;

/** 稳定原因码的形态：大写/小写标识符 + 下划线/点/连字符（拒绝空格、路径、凭据形态）。 */
const STABLE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * 最近一次跨层回退（进程内单值）。`null` = 本进程从未发生。
 *
 * @type {{role:string|null, fromTier:string, toTier:string, reasonCode:string|null, at:number}|null}
 */
let lastOrdinaryFallback = null;

/** 去控制字符、trim 并限长；非法/空串返回 null（诊断字段保持存在，值为 null）。 */
function boundedText(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, maxLength);
}

/** 稳定原因码归一：形态不符（含超长）一律 null，绝不透传任意自由文本。 */
function stableCode(value) {
  const text = boundedText(value, ROUTE_DIAGNOSTIC_CODE_MAX_LENGTH);
  return text !== null && STABLE_CODE_PATTERN.test(text) ? text : null;
}

/**
 * 记录一次跨层回退（覆盖上一条）。
 *
 * 只接受来自时段层（peak/valley）到普通层的回退：其它组合不是本票据要表达的事实，
 * 直接忽略（返回 false），绝不写半条记录。
 *
 * @param {{role?:unknown, fromTier?:unknown, toTier?:unknown, reasonCode?:unknown, at?:unknown}} entry
 * @returns {boolean} 是否已记录。
 */
export function noteRouteOrdinaryFallback(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const fromTier = entry.fromTier;
  if (fromTier !== "peak" && fromTier !== "valley") return false;
  const toTier = entry.toTier === void 0 ? "normal-fallback" : entry.toTier;
  if (toTier !== "normal-fallback") return false;
  lastOrdinaryFallback = Object.freeze({
    role: boundedText(entry.role, ROUTE_DIAGNOSTIC_ROLE_MAX_LENGTH),
    fromTier,
    toTier,
    reasonCode: stableCode(entry.reasonCode),
    at: typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at >= 0 ? entry.at : Date.now(),
  });
  return true;
}

/**
 * 只读投影：最近一次跨层回退的副本；从未发生时为 null。
 *
 * 返回浅拷贝，调用方（诊断投影/测试）无法改写本模块的单值。
 *
 * @returns {{role:string|null, fromTier:string, toTier:string, reasonCode:string|null, at:number}|null}
 */
export function lastOrdinaryFallbackDiagnostics() {
  return lastOrdinaryFallback === null ? null : { ...lastOrdinaryFallback };
}

/**
 * 复位单值（仅测试与诊断复位使用）。
 *
 * 生产路径不调用：进程重启天然清空；导出它是为了让「从未发生 = null」这条面可以在同一
 * 进程内被确定性验证，而不依赖测试执行顺序。
 *
 * @returns {void}
 */
export function resetRouteOrdinaryFallbackDiagnostics() {
  lastOrdinaryFallback = null;
}
