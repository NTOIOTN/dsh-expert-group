/**
 * 组合根顶层的第 S5 段（R1 票据 06）：自 index.js 第 486–692 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

// ── 只读能力矩阵与运行时诊断 ────────────────────────────────────────────────
/**
 * 诊断报告 schema 版本。
 *
 * capabilities / diagnostics 是给用户与维护者看的只读投影，不参与任何业务判定。
 * 字段语义变化时递增版本；客户端遇到未知版本必须整体忽略，绝不猜测字段含义。
 */
export const CAPABILITY_REPORT_VERSION = 2;

/** 最近 RPC 错误类别的保留上限；记录有界，绝不随失败次数增长。 */
export const RPC_ERROR_CATEGORY_LIMIT = 8;

/**
 * 诊断短标识符允许的字符面。
 *
 * 诊断字段只应来自插件自身固定的结构化 code（如 invalid-selection）或固定的能力名。
 * 任何超出该字符面的输入都无法证明是结构化类别，一律归一为 other，避免把错误消息、
 * 文件系统路径、会话标识或认证信息带进可读诊断面。
 */
const DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z0-9_./-]{1,40}$/;

/** 把任意输入归一为可安全展示的诊断 token；长度与字符面双重限制。 */
export function diagnosticToken(value, fallback = "other") {
  return typeof value === "string" && DIAGNOSTIC_TOKEN_PATTERN.test(value) ? value : fallback;
}

/** 诊断消息的最大长度（按字符计）：诊断面有界，长消息截断而不是整体放弃。 */
const DIAGNOSTIC_MESSAGE_LIMIT = 160;

/**
 * 把插件自身产生的结构化诊断文案归一为可安全展示的消息。
 *
 * 与 diagnosticToken 的分工：token 只允许短标识符字符面（用于 code/来源），message
 * 是给人读的固定文案（含中文与空格），不能过同一白名单。安全边界改由三件事保证：
 * 1. 长度上限——诊断面不随输入增长；
 * 2. 去掉控制字符并压缩换行——消息不会伪造多行日志/UI 结构；
 * 3. 只接受字符串——非字符串一律返回 fallback，不把对象/数组序列化进诊断。
 * 调用方（fanout 并发诊断）的文案由插件内部生成，不拼接设置原文或原始返回值。
 */
export function diagnosticMessage(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > DIAGNOSTIC_MESSAGE_LIMIT
    ? cleaned.slice(0, DIAGNOSTIC_MESSAGE_LIMIT) + "…"
    : cleaned;
}

/** 只接受非负安全整数计数；其它输入按 0 处理，诊断绝不返回 NaN/负数。 */
export function diagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 只接受非负安全整数时间戳；缺失/非法返回 null（区分"从未发生"与 1970）。 */
export function diagnosticTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 异常的安全标签：只保留"看起来像常规错误名"的标识符，其余一律归为 Error/类型名。
 *
 * 为什么**不能**输出 message：日志里的异常可能来自宿主 provider、会话读取器甚至文件系统，
 * message 里可能夹带会话正文、prompt 片段、绝对路径或凭据；日志只需要回答"哪一步失败、
 * 错误类型是什么"。白名单口径与 host/index-root-wait.js 的本地实现完全一致：只接受
 * ASCII 标识符（允许 . 分隔的命名空间形），长度上限 64；控制字符、换行、路径分隔符与
 * 中文等一律不输出，非对象按 typeof 归类。
 */
export function safeErrorLabel(error) {
  const isObject = error !== null && typeof error === "object";
  const name = isObject ? error.name : undefined;
  if (typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(name)) return name;
  return isObject ? "Error" : typeof error;
}

/**
 * 限流诊断的行数上限（票据 26）：role/provider 映射来自设置，诊断投影必须有界。
 * 超出部分按对象插入序截断——它们是低频配置项，不是需要完整分页的数据面。
 */
const THROTTLE_DIAGNOSTIC_ROW_LIMIT = 16;

/**
 * 限流/排队诊断的只读投影（票据 26）。
 *
 * 输入是 manager.throttleDiagnostics() 的形状：
 *   { roles: {role: row}, providers: {provider: row}, etaMinSamples }
 * 输出改写成有界数组，便于客户端直接渲染，且所有标量都过诊断白名单：
 * - 键名（role/provider）是公开配置，仍截断到 64 字符；
 * - 时间戳/计数/etaMs 用非负安全整数，缺失时显式 null；
 * - etaSource 只接受固定枚举（unknown / historical-average）。
 *
 * 绝不包含任务负载、prompt 或任何会话数据。
 *
 * @param {unknown} value - manager 的限流诊断。
 * @returns {{roles: object[], providers: object[], etaMinSamples: number}}
 */
export function projectThrottleDiagnostics(value) {
  const source = value !== null && typeof value === "object" ? value : {};
  const projectRow = (keyField, key, row) => {
    const entry = row !== null && typeof row === "object" ? row : {};
    return Object.freeze({
      [keyField]: key.slice(0, 64),
      // limit 0 表示不限制（provider 维度）；role 维度总是 >= 1 的生效默认值。
      limit: diagnosticCount(entry.limit),
      running: diagnosticCount(entry.running),
      queued: diagnosticCount(entry.queued),
      samples: diagnosticCount(entry.samples),
      lastThrottledAt: diagnosticTime(entry.lastThrottledAt),
      etaMs: diagnosticTime(entry.etaMs),
      etaSource: entry.etaSource === "historical-average" ? "historical-average" : "unknown",
    });
  };
  const projectMap = (map, keyField) => {
    if (map === null || typeof map !== "object") return Object.freeze([]);
    const rows = [];
    for (const key of Object.keys(map)) {
      if (rows.length >= THROTTLE_DIAGNOSTIC_ROW_LIMIT) break;
      if (typeof key !== "string" || key.length === 0) continue;
      rows.push(projectRow(keyField, key, map[key]));
    }
    return Object.freeze(rows);
  };
  return Object.freeze({
    roles: projectMap(source.roles, "role"),
    providers: projectMap(source.providers, "provider"),
    etaMinSamples: diagnosticCount(source.etaMinSamples),
  });
}

/**
 * 有界 RPC 错误类别记录器（只读诊断）。
 *
 * legacy HTTP 与 Connection 两条传输共用同一个 mapRpcError，因此这里记录的是同一份
 * "最近失败类别"视图。记录内容只有结构化 code、出现次数与最近一次时间戳：绝不保存
 * 错误消息、原始请求体、prompt、路径或认证信息，避免可观测性扩大泄露面。
 *
 * @param {object} [options]
 * @param {number} [options.limit] - 类别上限；超出后淘汰最久未出现的类别。
 */
export function createRpcErrorTracker({ limit = RPC_ERROR_CATEGORY_LIMIT } = {}) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : RPC_ERROR_CATEGORY_LIMIT;
  const categories = new Map();
  return Object.freeze({
    /** 记录一次已映射的错误类别；非法输入归一为 other，且绝不抛出。 */
    note(code) {
      const key = diagnosticToken(code);
      const current = categories.get(key);
      if (current === undefined) {
        categories.set(key, { code: key, count: 1, lastAt: Date.now() });
        if (categories.size > max) {
          // 淘汰最久未出现的类别；Map 迭代顺序即插入顺序，最旧的候选在队首附近。
          let oldestKey;
          let oldestAt = Infinity;
          for (const [candidate, entry] of categories) {
            if (entry.lastAt < oldestAt) {
              oldestAt = entry.lastAt;
              oldestKey = candidate;
            }
          }
          if (oldestKey !== undefined) categories.delete(oldestKey);
        }
        return;
      }
      current.count += 1;
      current.lastAt = Date.now();
      // 重新插入把该类别移到队尾，保证上限淘汰的是真正最久未出现的类别。
      categories.delete(key);
      categories.set(key, current);
    },
    /** 只读快照：按最近出现时间倒序，条数固定上限。 */
    snapshot() {
      return Object.freeze([...categories.values()]
        .sort((left, right) => right.lastAt - left.lastAt)
        .map((entry) => Object.freeze({ code: entry.code, count: entry.count, lastAt: entry.lastAt })));
    },
    clear() {
      categories.clear();
    },
  });
}

/**
 * 探测一个（可能是 Cordis 服务代理的）宿主服务能力。
 *
 * 只做 `typeof` 判定，绝不调用任何业务方法；Cordis 对未声明服务的属性读取会抛错，
 * 因此每个成员单独 try/catch。状态语义：
 * - available：服务存在且所需方法齐全；
 * - incomplete：服务存在但缺少方法（插件保持加载，只禁用受影响能力）；
 * - absent：服务未注入或为 null。
 *
 * @param {unknown} service
 * @param {string[]} methods
 * @returns {{status:string, methods:object}}
 */
function probeServiceCapability(service, methods) {
  const list = Array.isArray(methods) ? methods : [];
  if (service === undefined || service === null) {
    return { status: "absent", methods: Object.freeze(Object.fromEntries(list.map((method) => [method, false]))) };
  }
  const present = {};
  for (const method of list) {
    try {
      present[method] = typeof service[method] === "function";
    } catch {
      present[method] = false;
    }
  }
  return {
    status: list.every((method) => present[method] === true) ? "available" : "incomplete",
    methods: Object.freeze(present),
  };
}

/**
 * settings 读源接线入口（新契约）。
 *
 * 行为由 host/settings-source 持有：关闭宿主自动配置页、从 describe() 读取本条目
 * 当前值、在 document-updated 时刷新读源。这里只保留组合根投影名，便于源码契约
 * 测试与后续票据定位接线点。
 */
export function installSettingsSection(settingsSource, ctx, namespace, schema, entry, hooks) {
  return settingsSource.install(ctx, { namespace, schema, entry, hooks });
}

