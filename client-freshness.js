/**
 * Client 共享边界（浏览器安全的纯 ES 模块）。
 *
 * 这里保存 Client 双面共用的三组纯逻辑，不引用 React、DOM、cordis 或任何 Node API：
 * - freshness boundary：统一 session epoch、请求序列、settings revision、catalog
 *   generation 与 fan-out cursor，只保存 JSON 兼容快照，不发请求、不渲染；
 * - RPC 归一：把 DSH Connection envelope 与同源 fetch 归一成同一种 fetch-like
 *   Response，错误 code/status/details 在两条传输上完全一致；
 * - settings 提交：动态校验后的提交与本地 revision 辅助同步。
 *
 * client.js 是 DSH 的 classic bundle（`window.__ModuleLoader__.load({ id, factory })`），
 * 不能使用 ESM import；因此它通过下面的 descriptor 契约把本模块登记到同一个
 * ModuleLoader 表里，测试与面板共用同一份实现，不再复制逻辑：
 *
 *   globalThis.__ModuleLoader__.load(__DEG_CLIENT_FRESHNESS_DESCRIPTOR__);
 *
 * descriptor.factory 是同步的（DSH 的 require 只做同步 materialize），只依赖
 * globalThis，因此加载顺序不影响它。
 *
 * ## 权威实现与发布装载路径
 *
 * 本文件是 freshness/RPC 的**唯一权威实现**，两条装载路径共用同一份源码：
 * 1. 测试与相邻模块直接 `import` 本模块（ESM）；
 * 2. 发布 bundle 由 `scripts/assemble-client.mjs` 在构建期把本文件**投影**成 classic 片段
 *    （行首 `export ` 前缀去掉 + 追加"检查点 + ModuleLoader 登记"尾部），排在唯一
 *    descriptor 之前执行；因此真实 Host 上一定会登记 `__DEG_CLIENT_FRESHNESS_DESCRIPTOR__`，
 *    client.js 的 `require("dsh-expert-group/client-freshness")` 命中同一张模块表并取回它。
 *
 * client.js 里的同名内联实现只是"宿主没有该模块"（旧 Host、缓存里的旧页面）的兼容
 * fallback，不再是无验证的手工副本：构建期差分（`probeFreshnessFace`，见
 * scripts/assemble-client.mjs）与 test/client-shared-boundary.test.mjs 会逐项比较
 * 权威实现、投影片段与内联 fallback，任何漂移都会让 `pnpm build` / `pnpm test` 失败。
 */

/** 与 client.js 共用的模块 id：必须与 descriptor.id 完全一致。 */
export const CLIENT_FRESHNESS_MODULE_ID = "dsh-expert-group/client-freshness";

/**
 * classic 投影片段发布同一份导出面用的 globalThis Symbol 键（与相邻侧车模块的
 * `Symbol.for("dsh-expert-group/<name>")` 约定一致；字符串与模块 id 相同是刻意的，
 * 两者分别是模块表键与符号表键，不共享命名空间）。
 * 测试据此证明真实 bundle 装载的是本文件的实现，而不是 client.js 的内联副本。
 */
export const CLIENT_FRESHNESS_GLOBAL_KEY = "dsh-expert-group/client-freshness";

/**
 * RPC 错误 code -> HTTP-ish status。settings 冲突必须是 409（客户端据此刷新并
 * 保留 dirty 草稿），会话缺失是 404，认证/通道问题是 403，取消是 499。
 * @param {object} [error]
 * @returns {number}
 */
export function rpcErrorStatus(error) {
  const code = error?.code;
  if (code === "settings-conflict") return 409;
  if (code === "not-found" || code === "session-not-found") return 404;
  if (code === "forbidden" || code === "connection-required") return 403;
  if (code === "gateway/cancelled") return 499;
  if (code === "bad-request") return 400;
  return 500;
}

/**
 * 将 Connection envelope 归一为 fetch-like Response，保持两条传输的错误字段一致。
 * @param {object} [result] - { ok, value, error, status }。
 */
export function normalizePluginRpcResult(result) {
  const ok = result?.ok === true;
  const payload = ok ? result.value : { ok: false, error: result?.error };
  const status = ok ? 200 : (Number.isSafeInteger(result?.status) && result.status > 0 ? result.status : rpcErrorStatus(result?.error));
  return {
    ok,
    status,
    async json() { return payload; },
  };
}

/**
 * 优先使用 DSH Connection 的独立插件 channel，认证和 envelope 由 Connection 统一处理；
 * 没有新 Connection 的旧 Host 才回落到同源 fetch，保持历史客户端可用。
 *
 * @param {object} connection - ctx.connection（可选）。
 * @param {object} request - RPC body。
 * @param {object} [init] - fetch init（signal/credentials/headers 等）。
 * @param {Function} [fetchImpl] - fetch 实现，默认 globalThis.fetch。
 * @param {{path:string, channel:string, endpoint:string}} rpcTarget - 路由常量。
 */
export async function requestPluginRpc(connection, request, init = {}, fetchImpl = globalThis.fetch, rpcTarget) {
  const rpc = connection?.rpc;
  if (typeof rpc?.call === "function") {
    const result = await rpc.call(rpcTarget.channel, rpcTarget.endpoint, request, init.signal);
    return normalizePluginRpcResult(result);
  }
  if (typeof fetchImpl !== "function") throw new Error("当前 DSH 不支持插件 RPC");
  return fetchImpl(rpcTarget.path, {
    ...init,
    method: init.method ?? "POST",
    credentials: init.credentials ?? "same-origin",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body ?? JSON.stringify(request),
  });
}

/**
 * Client 双面共享的 freshness seam：统一 session epoch、请求序列、settings revision、
 * catalog generation 和 fan-out cursor。它只保存 JSON 兼容快照，不渲染、不发请求；
 * 所有迟到响应必须先通过对应 accept 方法，卸载后不会再通知调用方。
 */
export function createClientFreshnessBoundary({ sessionId = "", onUpdate } = {}) {
  let disposed = false;
  let currentSessionId = typeof sessionId === "string" ? sessionId : "";
  let sessionEpoch = 0;
  let sequence = 0;
  let notify = typeof onUpdate === "function" ? onUpdate : null;
  const latestRequests = new Map();
  let settings = { revision: -1, value: undefined };
  let catalog = { generation: -1, value: undefined };
  let fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };

  const requestKey = (kind, key = "") => String(kind) + "\u0000" + String(key ?? "");
  const isObject = (value) => value !== null && typeof value === "object";
  const safeRevision = (value) => Number.isSafeInteger(value) && value >= 0;
  const result = (accepted, reason, state) => ({ accepted, reason, ...(state === undefined ? {} : { state }) });
  const emit = (kind, state) => {
    if (disposed || notify === null) return;
    try { notify({ kind, state }); } catch { /* UI 订阅者异常不能破坏响应判定。 */ }
  };
  const tokenIsCurrent = (token) => {
    if (disposed) return false;
    if (token === undefined) return true;
    if (!isObject(token)) return false;
    if (token.epoch !== sessionEpoch || token.sessionId !== currentSessionId) return false;
    return latestRequests.get(token.key) === token.sequence;
  };

  const api = {
    beginSession(nextSessionId = "") {
      if (disposed) return Object.freeze({ accepted: false, reason: "disposed", sessionId: currentSessionId, epoch: sessionEpoch });
      currentSessionId = typeof nextSessionId === "string" ? nextSessionId : "";
      sessionEpoch += 1;
      sequence += 1;
      latestRequests.clear();
      fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };
      return Object.freeze({ accepted: true, sessionId: currentSessionId, epoch: sessionEpoch, sequence });
    },
    beginRequest(kind, key = "") {
      if (disposed) return Object.freeze({ accepted: false, reason: "disposed", kind, key, sessionId: currentSessionId, epoch: sessionEpoch, sequence });
      const normalizedKey = requestKey(kind, key);
      const token = { accepted: true, kind, key: normalizedKey, sessionId: currentSessionId, epoch: sessionEpoch, sequence: ++sequence };
      latestRequests.set(normalizedKey, token.sequence);
      return Object.freeze(token);
    },
    isCurrent(token) {
      return tokenIsCurrent(token);
    },
    isSessionCurrent(token) {
      return !disposed && isObject(token) && token.epoch === sessionEpoch && token.sessionId === currentSessionId;
    },
    acceptSettingsSnapshot({ revision, value, requestToken } = {}) {
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", settings);
      if (!safeRevision(revision)) return result(false, "invalid-revision", settings);
      if (revision < settings.revision) return result(false, "stale-revision", settings);
      if (revision === settings.revision && settings.value !== undefined) return result(false, "duplicate", settings);
      settings = { revision, value };
      emit("settings", settings);
      return result(true, undefined, settings);
    },
    acceptCatalogResponse({ generation, groups, value, requestToken } = {}) {
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", catalog);
      if (!safeRevision(generation)) return result(false, "invalid-generation", catalog);
      if (generation < catalog.generation) return result(false, "stale-generation", catalog);
      if (generation === catalog.generation && catalog.value !== undefined) return result(false, "duplicate", catalog);
      catalog = { generation, value: value === undefined ? groups : value };
      emit("catalog", catalog);
      return result(true, undefined, catalog);
    },
    acceptFanoutSnapshot({ sessionId: incomingSessionId, generation, cursor, snapshot, requestToken } = {}) {
      if (incomingSessionId !== currentSessionId) return result(false, "stale-session", fanout);
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request", fanout);
      if (!safeRevision(generation)) return result(false, "invalid-generation", fanout);
      if (!safeRevision(cursor)) return result(false, "invalid-cursor", fanout);
      if (generation < fanout.generation) return result(false, "stale-generation", fanout);
      if (cursor < fanout.cursor) return result(false, "stale-cursor", fanout);
      if (generation === fanout.generation && cursor === fanout.cursor && fanout.snapshot !== undefined) return result(false, "duplicate", fanout);
      fanout = { sessionId: currentSessionId, generation, cursor, snapshot };
      emit("fanout", fanout);
      return result(true, undefined, fanout);
    },
    acceptFanoutEvents({ sessionId: incomingSessionId, generation, cursor, events, snapshot, requestToken } = {}) {
      return api.acceptFanoutSnapshot({
        sessionId: incomingSessionId,
        generation,
        cursor,
        snapshot: snapshot === undefined ? events : snapshot,
        requestToken,
      });
    },
    acceptFanoutAction({ sessionId: incomingSessionId, generation, requestToken } = {}) {
      if (incomingSessionId !== currentSessionId) return result(false, "stale-session");
      if (!tokenIsCurrent(requestToken)) return result(false, "stale-request");
      if (generation !== undefined && (!safeRevision(generation) || generation < fanout.generation)) return result(false, "stale-generation");
      return result(true, undefined, fanout);
    },
    snapshot() {
      return {
        disposed,
        sessionId: currentSessionId,
        epoch: sessionEpoch,
        settings,
        catalog,
        fanout,
      };
    },
    dispose() {
      if (disposed) return false;
      disposed = true;
      latestRequests.clear();
      notify = null;
      settings = { revision: -1, value: undefined };
      catalog = { generation: -1, value: undefined };
      fanout = { sessionId: currentSessionId, generation: -1, cursor: 0, snapshot: undefined };
      return true;
    },
  };
  return Object.freeze(api);
}

/**
 * 通过 Host 动态校验并提交完整 settings 候选，失败时不改变本地 dirty 草稿。
 *
 * @param {object} settings - 完整候选值。
 * @param {number} revision - 本地观察到的 settings revision。
 * @param {object} deps
 * @param {Function} [deps.request] - legacy fetch 实现。
 * @param {object} [deps.connection] - ctx.connection。
 * @param {Function} deps.normalizeSettingsDraft - 候选归一（由 client.js 注入，依赖角色表）。
 * @param {Array<string>} deps.roles - 启用的角色 id。
 * @param {{path:string, channel:string, endpoint:string}} deps.rpcTarget - RPC 路由常量。
 */
export async function commitSettingsCandidate(settings, revision, { request = globalThis.fetch, connection, normalizeSettingsDraft, roles, rpcTarget } = {}) {
  const body = { action: "settings-commit", settings, expectedRevision: revision };
  const response = typeof connection?.rpc?.call === "function"
    ? await requestPluginRpc(connection, body, {}, globalThis.fetch, rpcTarget)
    : await request(rpcTarget.path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // settings 冲突必须把 Host 的权威 revision 暴露给调用方：客户端据此只推进本地
  // revision，同时保留 dirty 草稿；缺失该字段时退回 payload.revision 兼容旧 Host。
  return readSettingsCommitOutcome(response, normalizeSettingsDraft, roles);
}

/**
 * 解析 settings 提交响应：成功返回归一后的 settings 与 Host 权威 revision；
 * 失败抛出结构化错误（code/status/currentRevision），调用方据此保留 dirty 草稿。
 * currentRevision 依次取 error.details.revision、error.details.currentRevision、
 * payload.revision，兼容只回传其中之一的 Host 版本。
 *
 * @param {object} response - fetch-like Response（Connection 归一结果或真实 fetch）。
 * @param {Function} normalizeDraft - 候选归一函数（由 client.js 注入角色表）。
 * @param {Array<string>} roles - 启用的角色 id。
 */
export async function readSettingsCommitOutcome(response, normalizeDraft, roles) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("设置保存响应无效");
  }
  if (!response.ok || payload?.ok !== true) {
    const issue = payload?.error && typeof payload.error === "object" ? payload.error : {};
    const message = issue.message ?? payload?.message;
    const error = new Error(typeof message === "string" ? message : "设置保存失败");
    if (typeof issue.code === "string") error.code = issue.code;
    if (Number.isSafeInteger(response.status) && response.status > 0) error.status = response.status;
    const currentRevision = issue.details?.revision ?? issue.details?.currentRevision ?? payload?.revision;
    if (Number.isSafeInteger(currentRevision) && currentRevision >= 0) error.currentRevision = currentRevision;
    throw error;
  }
  if (!payload.settings || typeof payload.settings !== "object" || Array.isArray(payload.settings)
    || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new Error("设置保存响应无效");
  }
  const rolePrompts = payload.rolePrompts !== null && typeof payload.rolePrompts === "object"
    && !Array.isArray(payload.rolePrompts)
    ? payload.rolePrompts
    : void 0;
  return {
    settings: normalizeDraft(payload.settings, roles),
    revision: payload.revision,
    ...(rolePrompts === void 0 ? {} : { rolePrompts }),
  };
}

/**
 * classic bundle 登记用 descriptor：client.js 把它交给 `window.__ModuleLoader__.load`。
 * factory 同步且无参数依赖，加载顺序不影响结果。
 */
export const __DEG_CLIENT_FRESHNESS_DESCRIPTOR__ = Object.freeze({
  id: CLIENT_FRESHNESS_MODULE_ID,
  factory: () => Object.freeze({
    createClientFreshnessBoundary,
    rpcErrorStatus,
    normalizePluginRpcResult,
    requestPluginRpc,
    commitSettingsCandidate,
    readSettingsCommitOutcome,
    // client.js 通过本字段把 descriptor 登记回同一张表（见 registerClientFreshnessModule）。
    registerClientFreshnessModule,
  }),
});

/**
 * 已登记加载器的记账键。挂在当前 realm 的 globalThis 上而不是模块作用域里：
 * DSH 的 `ClientModuleSystem.register` 对同一个 id 是**抛错**语义
 * （`duplicate factory registration`），而 HMR 只失效主插件 id 后会重新执行同一份
 * bundle（投影片段也会再跑一次），所以"每个加载器实例只登记一次"必须跨执行共享。
 * 副作用是可用性权衡：freshness 源改动在 HMR 期间保持旧模块记录，整页刷新才更新。
 */
const REGISTERED_LOADERS_KEY = Symbol.for("dsh-expert-group/client-freshness#registered-loaders");

/**
 * 取当前 realm 的"已登记加载器"弱集合。用鸭子类型判断而不是 `instanceof`，
 * 避免跨 realm（vm / iframe / 测试替身）时误判并重新登记。
 */
function registeredLoaderSet(host) {
  const existing = host?.[REGISTERED_LOADERS_KEY];
  if (existing !== null && typeof existing === "object"
    && typeof existing.has === "function" && typeof existing.add === "function" && typeof existing.delete === "function") {
    return existing;
  }
  try {
    // 不枚举、不参与序列化：只是本 realm 的装载记账。
    const created = new WeakSet();
    Object.defineProperty(host, REGISTERED_LOADERS_KEY, { value: created, configurable: true, writable: true });
    return created;
  } catch {
    // globalThis 被冻结/受限时退回"不记账"的旧行为：宁可重复登记交给宿主判定，也不阻断装载。
    return null;
  }
}

/**
 * client.js 的 ModuleLoader adapter：在 bundle 内把本模块登记进同一个模块表。
 * 没有可用加载器或该加载器已登记过时静默跳过（宿主对重复 id 会抛错）。
 *
 * @param {object} [loader] - DSH 的 `window.__ModuleLoader__` 门面。
 * @returns {boolean} 本次是否执行了登记。
 */
export function registerClientFreshnessModule(loader = globalThis.__ModuleLoader__) {
  if (loader === null || typeof loader !== "object" || typeof loader.load !== "function") return false;
  const registered = registeredLoaderSet(globalThis);
  if (registered !== null && registered.has(loader)) return false;
  if (registered !== null) registered.add(loader);
  try {
    loader.load(__DEG_CLIENT_FRESHNESS_DESCRIPTOR__);
  } catch (error) {
    // 登记失败必须回滚记账：否则下一次执行会误判成"已登记"而永久放弃装载。
    if (registered !== null) registered.delete(loader);
    throw error;
  }
  return true;
}
