/**
 * 入口 Connection RPC 通道域（R4e · 票据 19）。
 *
 * 这一域负责 DSH Connection 传输的**通道建立与 envelope 转换**，业务 dispatch 与
 * legacy HTTP 完全共用 `dispatchRpcAction`（票据 20 范围，仍在 `index.js`）：
 * - 首选宿主独立 channel：`connection.rpc.handle(RPC_CHANNEL, handler)`；
 * - handle API 缺失或注册失败时，在 `connection.requestRejection` fence 可用时由插件
 *   自持同名前缀 route（wire 形状仍是公开的 client-request / server-response）；
 * - 两者都不可用时 fail-closed：legacy exact route 必须继续拒绝并返回 503，绝不把
 *   版本不匹配或宿主缺陷变成 browser-auth/token fence 的认证旁路。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx：`ctx.inject(["connection"], ...)` 的注册仍由 `index.js` 在原注册点执行，
 * 这里只接收一个 `install(connectionCtx)` 入口与 `fallbackEffect`（ctx.effect 适配器）。
 * legacy exact route 的 `ctx.effect(() => webServer.register(...))` 也仍在 `index.js`。
 *
 * ## 状态唯一 owner
 * 本模块独占 Connection 通道的 5 个只读状态（active / registrationFailed / probe /
 * transport / failureCode）。组合根只经 `isActive()` / `isRegistrationFailed()` 与
 * `describe()` 读取，不直接写在模块外。
 *
 * @module dsh-expert-group/host/index-connection-channel
 */
import {
  channelEndpointFromPath,
  createConnectionRpcHandler,
  readClientRequestEnvelope,
  rpcIdFromEnvelopeText,
  writeServerResponseEnvelope,
} from "../rpc-host.js";
import { RPC_CHANNEL, RPC_ENDPOINT } from "../shared/protocol.js";

/** 通道生命周期的 effect 标签（与迁移前的字面量一致）。 */
const CONNECTION_CHANNEL_EFFECT = "dsh-expert-group: connection rpc channel";

/**
 * 创建 Connection RPC 通道能力面。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与错误消息）。
 * @param {object} deps.hostRpc - host.rpc 组合面：`probe`、`createRegistration`、
 *   `readBody`、`isBodyTooLarge`。
 * @param {object} deps.webServer - 宿主 webServer：`register({kind:"prefix",...})`（备用 route）。
 * @param {object} deps.http - HTTP 传输面（host/index-rpc-http.js）：`sendJson`、`sendText`、
 *   `contentTypeAllowed`。
 * @param {object} deps.errorTracker - RPC 错误类别诊断：`note(code)`。
 * @param {object} deps.lifecycle - 请求生命周期工厂：`lifecycle(req, res)`。
 * @param {object} deps.dispatch - 业务 dispatch：`dispatchRpcAction(body, signal, respond, options)`。
 * @param {Function} deps.fallbackEffect - 插件 fiber 的 `ctx.effect` 绑定（宿主未提供
 *   connection effect 时回落）。
 * @returns {object} 通道能力面 + 只读状态投影。
 */
export function createConnectionChannel({ logger, hostRpc, webServer, http, errorTracker, lifecycle, dispatch, fallbackEffect }) {
  let connectionRpcActive = false;
  let connectionRpcRegistrationFailed = false;
  /**
   * 只读能力矩阵的连接状态（诊断专用，不参与任何判定）：
   * - connectionProbeStatus：Connection 服务探测结果 absent / unsupported / available；
   * - connectionChannelTransport：最终承载通道 "handle"（宿主独立 channel）、
   *   "route"（插件自持同名前缀路由）或 "none"；
   * - connectionFailureCode：固定枚举的失败原因。绝不写入宿主错误消息——那可能包含
   *   内部实现细节，诊断面只暴露可解释的类别。
   */
  let connectionProbeStatus = "absent";
  let connectionChannelTransport = "none";
  let connectionFailureCode = null;

  /**
   * Connection adapter：只负责 endpoint 校验、payload/abort signal 传递与 Connection
   * envelope 转换；业务结果与 legacy 完全共用 dispatchRpcAction。
   */
  const connectionRpcAdapter = createConnectionRpcHandler({ endpoint: RPC_ENDPOINT, dispatch: dispatch.dispatchRpcAction });

  async function handleConnectionRpc(endpoint, payload, signal) {
    return connectionRpcAdapter(endpoint, payload, signal);
  }

  /**
   * 自持 channel 路由的 HTTP handler：当宿主缺少 rpc.handle，或 handle 注册因宿主
   * Connection context 缺陷失败时，提供插件侧兼容传输。后者是当前 DSH 版本的实际
   * 兼容边界：插件不能修改 DSH，因此在仍具备公开 requestRejection fence 时接管路由。
   * 如果备用 route 自身也注册失败，外层仍会 fail-closed 到 503。
   *
   * 通道本身只用公开 seam 复刻：connection.requestRejection 提供与 /api 完全相同的
   * Host/Origin + browser-auth fence，wire 形状仍是公开的 client-request /
   * server-response，客户端无需区分两条传输，回退也不会降低认证强度。
   */
  async function handleChannelRequest(req, res, connection) {
    const requestLifecycle = lifecycle(req, res);
    let channelRpcId;
    try {
      // fence 必须先于任何解析：未通过信任/认证的请求不进入 envelope，也读不到 body。
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) {
        http.sendText(res, rejection, rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
      const endpoint = channelEndpointFromPath(RPC_CHANNEL, new URL(req.url ?? "/", "http://dsh.internal").pathname);
      // 与宿主 rpcFetchHandler 一致：非 POST 或未声明的 endpoint 一律 404，不暴露内部形状。
      if (req.method !== "POST" || endpoint === undefined) { http.sendText(res, 404, "not found"); return; }
      if (!http.contentTypeAllowed(req)) { http.sendText(res, 415, "content type must be application/json"); return; }
      const raw = await hostRpc.readBody(req);
      let envelope;
      try {
        envelope = JSON.parse(raw || "{}");
      } catch {
        http.sendText(res, 400, "body is not JSON"); return;
      }
      const parsed = readClientRequestEnvelope(envelope, endpoint);
      channelRpcId = parsed.rpcId;
      if (parsed.ok !== true) {
        // envelope 形状错误同样是传输级拒绝入口：类别进入诊断，消息仍只回给该请求。
        errorTracker.note(parsed.code);
        http.sendJson(res, 200, writeServerResponseEnvelope(parsed.rpcId, {
          ok: false,
          error: { code: parsed.code, message: parsed.message, details: {} },
        }));
        return;
      }
      const result = await connectionRpcAdapter(endpoint, parsed.payload, requestLifecycle.signal);
      http.sendJson(res, 200, writeServerResponseEnvelope(parsed.rpcId, result));
    } catch (error) {
      // 自持 channel 超限仍需返回 200 server-response，保持客户端 envelope 关联；
      // rpcId 从传输层保留的有界前缀恢复，不能退化成 transport-failure。
      if (hostRpc.isBodyTooLarge(error) || requestLifecycle.signal.aborted === true
        || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        let rpcId = channelRpcId;
        if (rpcId === undefined) {
          let fallbackPrefix = error?.prefix;
          if (typeof fallbackPrefix !== "string") {
            try { fallbackPrefix = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}); }
            catch { fallbackPrefix = ""; }
          }
          rpcId = rpcIdFromEnvelopeText(fallbackPrefix);
        }
        const mapped = hostRpc.isBodyTooLarge(error)
          ? { code: "payload-too-large", message: "请求体超过允许上限", details: {} }
          : { code: "gateway/cancelled", message: "请求已取消", details: {} };
        // 自持 channel 的早停路径也记类别：诊断面因此覆盖两条传输的全部拒绝入口，
        // 仍然只保存结构化 code，不保存读取到的前缀或错误消息。
        errorTracker.note(mapped.code);
        http.sendJson(res, 200, writeServerResponseEnvelope(rpcId, { ok: false, error: mapped }));
        return;
      }
      logger.warn("dsh-expert-group channel route failed: " + (error instanceof Error ? error.message : String(error)));
      http.sendText(res, 500, "handler failure");
    } finally {
      requestLifecycle.dispose();
    }
  }

  /**
   * 建立 Connection 通道（由 `ctx.inject(["connection"], ...)` 回调调用）。
   * 注册失败/API 缺失时按上面的三种边界 fail-closed，不静默降级成未认证路由。
   * @param {object} connectionCtx - ctx.inject 回调收到的 Connection 上下文。
   */
  function install(connectionCtx) {
  // 由组合模块统一判定 Connection 是否注入、是否支持 handle。三种结果的边界：
  // absent   → 保持 legacy exact route 服务（兼容旧宿主，与 fence 无关）。
  // handle API 缺失，或 handle 注册失败 → 有 fence 时自持同名前缀 route，无 fence 时
  //   fail-closed；备用 route 注册失败时同样 fail-closed。
  const transport = hostRpc;
  const probe = transport.probe(connectionCtx);
  connectionProbeStatus = probe.status;
  if (probe.status === "absent") return;
  if (probe.status === "unsupported") {
    connectionFailureCode = "probe-unsupported";
    logger.warn("dsh-expert-group " + probe.reason);
  }
  let connection;
  try {
    connection = connectionCtx?.connection;
  } catch (error) {
    connectionRpcRegistrationFailed = true;
    connectionFailureCode = "connection-unavailable";
    logger.warn("dsh-expert-group connection rpc unavailable: " + (error instanceof Error ? error.message : String(error)));
    return;
  }
  const rpc = probe.rpc;
  // 宿主 Connection 上是否真的存在 handle API。handle 缺失和注册失败都可在
  // requestRejection fence 可用时走插件备用 route；最终 route 注册失败仍会 fail-closed。
  const handleAvailable = typeof rpc?.handle === "function";
  // 已经建立的注册按后进先出释放；卸载或重新注入时不会把通道泄漏给下一个实例。
  const releases = [];
  const release = () => {
    connectionRpcActive = false;
    connectionChannelTransport = "none";
    while (releases.length > 0) {
      const dispose = releases.pop();
      try { void dispose(); } catch { /* 释放失败只影响该注册，不能阻塞卸载。 */ }
    }
  };
  // 首选宿主独立 channel：认证、envelope 与 node↔Fetch bridge 全由 Connection 完成。
  // 宿主 handle 缺失或注册失败时，再由插件使用同一公开 fence 自持路由；不抢占
  // Gateway 已注册的 /api interceptor，也不绕过 requestRejection。
  if (handleAvailable) {
    try {
      const removeHandle = rpc.handle(RPC_CHANNEL, handleConnectionRpc);
      releases.push(() => removeHandle?.());
      connectionRpcActive = true;
      connectionChannelTransport = "handle";
    } catch (error) {
      // 当前 DSH 版本的 handle 注册可能因 Connection 自身 context 缺少 webServer 而失败。
      // 插件不能修改 DSH 本体，因此保留告警并继续尝试带 requestRejection fence 的
      // 插件自持 route；只有备用 route 也失败时才置为 fail-closed。
      connectionFailureCode = "handle-registration-failed";
      logger.warn("dsh-expert-group connection rpc channel unavailable, trying plugin route: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  // handle 缺失或 handle 注册失败时走此兼容回退；requestRejection 是必须的
  // 安全前提，不能在没有公开认证 fence 的情况下自行暴露 channel。
  if (connectionRpcActive !== true && connectionRpcRegistrationFailed !== true
    && typeof connection?.requestRejection === "function") {
    try {
      const removeRoute = webServer.register({
        kind: "prefix",
        path: RPC_CHANNEL,
        handler: (req, res) => handleChannelRequest(req, res, connection),
      });
      releases.push(() => removeRoute?.());
      connectionRpcActive = true;
      connectionChannelTransport = "route";
      logger.info("dsh-expert-group connection channel served by plugin-hosted route");
    } catch (error) {
      connectionRpcRegistrationFailed = true;
      connectionFailureCode = "route-registration-failed";
      logger.warn("dsh-expert-group connection channel route registration failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (connectionRpcActive !== true) {
    // Connection 存在但通道建立不起来（handle API 缺失、handle 注册失败或自持 route
    // 注册失败）：legacy route 必须保持拒绝并返回 503，不能把版本不匹配或宿主缺陷变成
    // browser-auth/token fence 的认证旁路。
    connectionRpcRegistrationFailed = true;
    connectionChannelTransport = "none";
    if (connectionFailureCode === null) {
      connectionFailureCode = handleAvailable !== true ? "handle-api-unavailable" : "channel-unavailable";
    }
    if (handleAvailable !== true) {
      logger.warn("dsh-expert-group connection rpc handle API unavailable");
    }
    return;
  }
  try {
    // 生命周期绑定统一由 hostRpc 组合模块完成：优先跟随 Connection 服务，
    // 宿主未提供 effect 时才回落到插件 fiber，且 release 本身保持幂等。
    const registration = hostRpc.createRegistration({
      connectionCtx,
      fallbackEffect,
      release,
      label: CONNECTION_CHANNEL_EFFECT,
    });
    registration.attach();
  } catch (error) {
    release();
    connectionRpcRegistrationFailed = true;
    connectionFailureCode = "effect-registration-failed";
    logger.warn("dsh-expert-group connection channel effect registration failed: " + (error instanceof Error ? error.message : String(error)));
  }
  }

  /** 通道是否已建立（handle 或插件自持 route）。 */
  function isActive() {
    return connectionRpcActive;
  }

  /** 通道是否已 fail-closed（legacy route 必须继续拒绝）。 */
  function isRegistrationFailed() {
    return connectionRpcRegistrationFailed;
  }

  /** 只读连接状态投影（诊断用，字段与迁移前完全一致）。 */
  function describe() {
    return {
      active: connectionRpcActive,
      registrationFailed: connectionRpcRegistrationFailed,
      probe: connectionProbeStatus,
      transport: connectionChannelTransport,
      failure: connectionFailureCode,
    };
  }

  return {
    handleConnectionRpc,
    handleChannelRequest,
    install,
    isActive,
    isRegistrationFailed,
    describe,
  };
}
