/**
 * 峰谷时段判定（权威纯函数源）。
 *
 * 本文件是「峰谷时段」语义的**唯一权威实现**：Host 校验、客户端界面提示与构建期
 * classic 投影都从这里取同一份规则。**不得出现第二份实现**——任何一端另写一份判定
 * （哪怕逻辑看起来一样）都会让"界面提示已保存、Host 却按另一套判定计费"重新出现，
 * 这正是本轮票据要消除的漂移面。投影只允许做逐行的机械导出改写，不改写语义。
 *
 * 本模块无状态、无宿主依赖（不 import 任何模块、不读 settings、不碰 DOM），
 * 只用 ECMAScript 内建能力，因此 Host 与浏览器 bundle 都能安全加载。
 *
 * ── 语义约定（全部实现都必须遵守）────────────────────────────────────────
 * 1. **左闭右开**：时段是 [start, end)。08:00–10:00 覆盖 08:00:00 到 09:59:59，
 *    10:00 整点属于时段之外。理由是"相接段"要能无歧义地拼接：08–10 与 10–12 在
 *    10:00 只命中后一段，不会出现"两个时段都算"的重叠，也不会留下空档。
 * 2. **跨午夜**：结束早于开始表示跨过 00:00，例如 23:00–02:00 覆盖 23:00–23:59
 *    与 00:00–01:59。判定时按"分钟轴上的并集"处理，不需要调用方自己拆段。
 * 3. **并集**：多条时段允许重叠、允许首尾相接；"是否命中峰时"只看并集是否包含该分钟，
 *    与段的顺序、条数无关。**顺序只在归一化时被保留**（配置回显、用户心智），
 *    判定与覆盖检查都不依赖顺序。
 * 4. **非法值 fail-closed**：任何"不确定"的输入都不许被猜成峰时——
 *    归一化遇到非法项整体拒绝（不部分保留），判定函数遇到非法分钟/非法 Date/非法时段
 *    一律判"谷时"且**绝不抛异常**。宁可少收峰时，也不能因为解析差异多收。
 * 5. **不 trim、不猜测**：时间字符串只接受严格的 HH:mm（见 HHMM_PATTERN）。
 *    "8:00"、"24:00"、"08:00 " 全部非法，避免两端对同一条配置做不同宽松解释。
 *
 * @module dsh-expert-group/shared/peak-valley-time
 */

/** 一天的分钟数。所有判定都在这个整数轴上做，Date/DST 不参与区间计算。 */
const MINUTES_PER_DAY = 1440;

/**
 * 允许配置的峰谷时段条数上限。
 *
 * 取 3 是产品约束：一天里保留"早峰 / 晚峰 / 一个特例"已经够用，条数再多界面无法
 * 在一屏里讲清，也容易让用户以为"没生效"（段太碎）。超限是整体拒绝，不是截断。
 */
export const MAX_PEAK_VALLEY_PERIODS = 3;

/** 峰谷时段归一失败时返回的稳定错误码（不随文案改动，客户端按它做 i18n）。 */
export const PEAK_VALLEY_PERIODS_INVALID = "PEAK_VALLEY_PERIODS_INVALID";

/**
 * 严格 HH:mm 形状：两位小时 00–23 + 冒号 + 两位分钟 00–59。
 *
 * 明确不接受近似写法（"8:00" 缺前导零、"24:00" 越界、"08：00" 全角冒号、
 * 带首尾空白），因为归一化不做 trim：宽容解析会让"用户看到的"与"存进去的"
 * 变成两个字符串，跨端比较（以及后续的投影）都会出现假性不一致。
 */
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 构造归一失败结果。
 *
 * reason 只用于日志与设置页提示（中文、带位置信息）；程序判定一律读 code，
 * 不要去匹配 reason 文案。
 *
 * @param {string} reason - 人类可读的失败原因。
 * @returns {{ok:false, code:string, reason:string}} 失败结果（每次新建对象）。
 */
function invalidPeriods(reason) {
  return { ok: false, code: PEAK_VALLEY_PERIODS_INVALID, reason };
}

/**
 * 把严格的 HH:mm 文本解析成一天内的分钟数。
 *
 * @param {unknown} value - 候选时间文本。
 * @returns {number|null} 0..1439；形状不合法时返回 null（0 是合法值，故不用 -1 做哨兵）。
 */
function parseClockMinutes(value) {
  if (typeof value !== "string" || !HHMM_PATTERN.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

/**
 * 归一化一份峰谷时段配置。
 *
 * 规则（Host 写入校验与客户端草稿必须完全一致）：
 * - 缺省（undefined / null）与空数组都表示"0 条合法配置"，即全天谷时；
 * - 必须是数组，每项必须是含 start / end 字符串字段的对象；
 * - start / end 必须严格匹配 HH:mm；start === end 属于空区间，非法；
 * - 结束早于开始按"跨午夜"接受（例如 23:00–02:00）；
 * - 最多 MAX_PEAK_VALLEY_PERIODS 条；
 * - **任一项非法则整体非法**：不部分保留、不静默丢弃坏项（丢弃会让用户以为生效了）；
 * - 成功时保持用户原始顺序，**绝不重排、合并、拆分**，且返回的是新建副本，
 *   调用方后续修改入参不会影响归一结果。
 *
 * @param {unknown} raw - settings / RPC 里的原始值。
 * @returns {{ok:true, periods:Array<{start:string,end:string}>}|{ok:false, code:string, reason:string}}
 *   归一结果；失败时 periods 不存在，调用方必须整体拒绝而不是回退到空数组。
 */
export function normalizePeakValleyPeriods(raw) {
  if (raw === void 0 || raw === null) return { ok: true, periods: [] };
  if (!Array.isArray(raw)) return invalidPeriods("峰谷时段必须是 {start,end} 数组");
  if (raw.length > MAX_PEAK_VALLEY_PERIODS) {
    return invalidPeriods("峰谷时段最多 " + MAX_PEAK_VALLEY_PERIODS + " 条，收到 " + raw.length + " 条");
  }
  const periods = [];
  for (let index = 0; index < raw.length; index += 1) {
    const position = "第 " + (index + 1) + " 项";
    const item = raw[index];
    // 数组也算"非对象"：它是容器而不是 {start,end} 载体，按字段缺失处理更直白。
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return invalidPeriods(position + "不是 {start,end} 对象");
    }
    const start = item.start;
    const end = item.end;
    if (typeof start !== "string" || typeof end !== "string") {
      return invalidPeriods(position + "缺少 start/end 字符串字段");
    }
    if (parseClockMinutes(start) === null) {
      return invalidPeriods(position + "的 start 必须是 00:00–23:59 的 HH:mm");
    }
    if (parseClockMinutes(end) === null) {
      return invalidPeriods(position + "的 end 必须是 00:00–23:59 的 HH:mm");
    }
    if (start === end) {
      return invalidPeriods(position + "的 start 与 end 不能相同（空区间非法）");
    }
    periods.push({ start, end });
  }
  return { ok: true, periods };
}

/**
 * 判断某个"当天第几分钟"是否落在峰时段的并集内。
 *
 * 每段按左闭右开 [start, end) 命中；start > end 的段按跨午夜处理
 * （minutes >= start 或 minutes < end）。多条段之间是并集关系。
 *
 * fail-closed：minutes 必须是 0..1439 的有限整数，否则判"谷时"并且不抛异常；
 * periods 不是数组、某段字段非法或 start === end 时，该段视为不生效（同样不抛）。
 * 理由：这是计费/展示共用的判定入口，异常会把「设置页一次脏数据」放大成整页崩溃，
 * 而误判峰时的代价高于误判谷时。
 *
 * @param {unknown} periods - 归一化后的时段数组（直接传原始数组也可，非法项被跳过）。
 * @param {unknown} minutes - 当天第几分钟，0..1439。
 * @returns {"peak"|"valley"} 命中峰时返回 "peak"，否则 "valley"（0 条恒为 "valley"）。
 */
export function peakValleyAtMinutes(periods, minutes) {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) return "valley";
  if (!Array.isArray(periods)) return "valley";
  for (const period of periods) {
    if (period === null || typeof period !== "object") continue;
    const start = parseClockMinutes(period.start);
    const end = parseClockMinutes(period.end);
    if (start === null || end === null || start === end) continue;
    // 跨午夜段在分钟轴上是一个"环绕"区间：尾段 [start,1440) 与头段 [0,end) 的并集。
    const hit = start < end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;
    if (hit) return "peak";
  }
  return "valley";
}

/**
 * 读取 Date 的本地墙钟分钟数。
 *
 * 只用 getHours()/getMinutes()：峰谷时段是"用户本地墙钟"的概念，不能用 UTC 小时
 * （跨时区会整体偏移）。Date 非法时返回 null——包括 getTime() 为 NaN、Date 上没有
 * 可调用方法（传了 null / 数字 / 普通对象）以及方法内部抛错，全部统一成 null。
 *
 * @param {unknown} date - 调用方给的 Date（或任何"看起来像 Date"的值）。
 * @returns {number|null} 0..1439，或 null 表示"无法取到墙钟"。
 */
function localWallClockMinutes(date) {
  try {
    if (date === null || typeof date !== "object") return null;
    if (typeof date.getTime !== "function" || typeof date.getHours !== "function" || typeof date.getMinutes !== "function") {
      return null;
    }
    if (Number.isNaN(date.getTime())) return null;
    const hours = date.getHours();
    const minutes = date.getMinutes();
    if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  } catch {
    return null;
  }
}

/**
 * 通知调用方"日期非法"。
 *
 * 观测回调只用于埋点/日志：它自身抛错必须被吞掉，否则一个诊断回调就能把渲染打挂。
 * options 缺失、不是对象、onInvalidDate 不是函数时都静默跳过（同样不抛）。
 *
 * @param {unknown} options - 调用方传入的选项袋。
 * @param {unknown} date - 原始 date 值，原样交给回调（可能是 null/数字/非法 Date）。
 */
function notifyInvalidDate(options, date) {
  if (options === null || typeof options !== "object") return;
  const callback = options.onInvalidDate;
  if (typeof callback !== "function") return;
  try {
    callback(date);
  } catch {
    // 观测失败不影响判定：这里不允许让诊断逻辑改变"谷时"这个 fail-closed 结果。
  }
}

/**
 * 按"用户本地墙钟"判定某个 Date 是否处于峰时。
 *
 * 只取本地小时/分钟，日期本身（年月日）不参与判定；秒与毫秒被忽略（分钟粒度）。
 * 非法 Date 返回 "valley" 并**至多**调用一次 options.onInvalidDate(date)，
 * 回调抛错也被吞掉——任何情况下本函数都不抛异常。
 *
 * @param {unknown} periods - 归一化后的时段数组。
 * @param {unknown} date - 待判定的 Date。
 * @param {{onInvalidDate?: (date: unknown) => void}} [options] - 观测钩子。
 * @returns {"peak"|"valley"} 判定结果（非法输入一律 "valley"）。
 */
export function peakValleyAtDate(periods, date, options) {
  const minutes = localWallClockMinutes(date);
  if (minutes === null) {
    notifyInvalidDate(options, date);
    return "valley";
  }
  return peakValleyAtMinutes(periods, minutes);
}

/**
 * 把时段展开成分钟轴上的半开区间列表（跨午夜段拆成两截）。
 *
 * 只读入参、不改写：返回的是本函数自己新建的数组，调用方的顺序与内容都不受影响。
 *
 * @param {unknown} periods - 时段数组。
 * @returns {Array<[number, number]>} [start,end) 形式的区间（可能为空数组）。
 */
function peakSpansOf(periods) {
  const spans = [];
  if (!Array.isArray(periods)) return spans;
  for (const period of periods) {
    if (period === null || typeof period !== "object") continue;
    const start = parseClockMinutes(period.start);
    const end = parseClockMinutes(period.end);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      spans.push([start, end]);
    } else {
      // 跨午夜：尾段到 24:00，头段从 00:00 起。
      spans.push([start, MINUTES_PER_DAY]);
      spans.push([0, end]);
    }
  }
  return spans;
}

/**
 * 时段并集是否覆盖整天（0..1439 全部为峰时）。
 *
 * **只用于界面提示**（例如"当前设置等于全天峰时，峰谷计费不会产生差异"），
 * 不参与判定：即使返回 false，实际命中仍以 peakValleyAtMinutes 的并集结果为准。
 * 内部会排序合并区间，但排序只发生在局部数组上——**输入顺序与归一化输出的顺序语义
 * 都不被改写**，本函数只返回布尔值。
 *
 * fail-closed：periods 不是数组或某段非法时按"该段不存在"处理（于是通常返回 false），
 * 不抛异常。
 *
 * @param {unknown} periods - 归一化后的时段数组。
 * @returns {boolean} 并集是否覆盖 1440 分钟。
 */
export function peakValleyPeriodsCoverFullDay(periods) {
  const spans = peakSpansOf(periods);
  // 排序 + 归并只作用于局部副本：区间可能来自跨午夜拆段，输入顺序不保证有序。
  spans.sort((left, right) => left[0] - right[0]);
  let coveredUntil = 0;
  for (const span of spans) {
    if (span[0] > coveredUntil) return false; // 出现空档：0..coveredUntil 之后断开
    if (span[1] > coveredUntil) coveredUntil = span[1];
    if (coveredUntil >= MINUTES_PER_DAY) return true;
  }
  return coveredUntil >= MINUTES_PER_DAY;
}
