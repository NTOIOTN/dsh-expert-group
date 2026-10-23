/**
 * 入口 RPC 传输的 HTTP 面（R4e · 票据 19）。
 *
 * 这一域只承载 **legacy HTTP 传输** 的收尾助手：响应信封（sendJson/sendText/sendError）、
 * 同源与内容类型校验（parseHost/isLoopbackHostname/sameOrigin/contentTypeAllowed）、
 * 有界请求体读取（readBody）与“响应是否真的交付”的判定（responseDelivered）。
 *
 * 业务 dispatch（`dispatchRpcAction`）与错误映射（`mapRpcError`）**不在本域**：
 * 它们属于票据 20（R4f）的范围，仍留在 `index.js`；本模块只提供它们使用的传输原语。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册任何路由：`ctx.effect(() => webServer.register(...))` 与
 * `ctx.inject(["connection"], ...)` 仍由 `index.js` 在原注册点执行。
 *
 * ## 行为等价
 * 状态码/错误 code 词表、同源严格比较（协议+主机+端口三者一致、Origin 必须精确等于
 * http(s)://Host）、content-type 归一（允许 charset）、16KiB 默认读体上限与超限时的
 * drain/resume 语义、以及 PayloadTooLargeError/BadJsonError 的类身份全部不变——后者被
 * `mapRpcError` 的 instanceof 判定直接依赖，类必须只定义一次并由入口统一导入。
 *
 * @module dsh-expert-group/host/index-rpc-http
 */

/** 请求体超过大小限制（`mapRpcError` 依赖该类身份映射 413 payload-too-large）。 */
export class PayloadTooLargeError extends Error {}
/** 请求体不是合法 JSON（`mapRpcError` 依赖该类身份映射 400 bad-request）。 */
export class BadJsonError extends Error {}

/**
 * 创建 legacy HTTP 传输面。
 *
 * @param {object} deps - 窄能力面（3 组）。
 * @param {object} deps.hostRpc - host/rpc-transport 组合面：`finalizeResponse(res,status,value)`
 *   （“最多写一次响应”的收敛规则由它持有）。
 * @param {object} deps.webServer - 宿主 webServer 服务：只读 `port`（同源端口比较）。
 * @param {object} deps.errorTracker - RPC 错误类别诊断：`note(code)`（只记 code/次数/时间戳）。
 * @returns {object} 传输助手能力面。
 */
export function createRpcHttpSurface({ hostRpc, webServer, errorTracker }) {

  function sendJson(res, status, value) {
    return hostRpc.finalizeResponse(res, status, value);
  }
  function sendText(res, status, value) {
    return hostRpc.finalizeResponse(res, status, value);
  }
  /**
   * legacy HTTP 错误信封。details 只在确有结构化附加信息时携带（当前只有 settings
   * 冲突的权威 revision），因此其它错误形状与历史完全一致。
   */
  function sendError(res, status, code, message, details) {
    // 传输层与业务层的结构化失败都经由这里写响应：只在收口点记一次类别，
    // 记录只有 code/次数/时间戳，不含 message、请求体或路径。
    errorTracker.note(code);
    sendJson(res, status, {
      ok: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    });
  }

  /** 解析 Host 头：返回 { hostname, port }；非法或缺省端口返回 null。 */
  function parseHost(host) {
    if (typeof host !== "string" || host.length === 0) return null;
    let rest = host.trim();
    // IPv6 字面量：[::1]:3080
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) return null;
      const hostname = rest.slice(1, close);
      const after = rest.slice(close + 1);
      if (after === "") return { hostname, port: 80 };
      if (!after.startsWith(":")) return null;
      const port = Number(after.slice(1));
      if (!Number.isInteger(port)) return null;
      return { hostname, port };
    }
    const parts = rest.split(":");
    if (parts.length === 1) return { hostname: parts[0], port: 80 };
    if (parts.length === 2) {
      const port = Number(parts[1]);
      if (!Number.isInteger(port)) return null;
      return { hostname: parts[0], port };
    }
    return null;
  }

  /** 仅允许 loopback 主机名，防止 DNS rebinding 把本机私有 RPC 打到远程站点。 */
  function isLoopbackHostname(hostname) {
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  }

  /** 严格同源校验：Origin 必须等于当前请求的 http(s)://host，且 host 为 loopback、端口等于当前 webServer.port。 */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin.length === 0) return false;
    const hostInfo = parseHost(req.headers.host);
    if (hostInfo === null) return false;
    if (!isLoopbackHostname(hostInfo.hostname)) return false;
    if (hostInfo.port !== webServer.port) return false;
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return false;
    }
    const originHost = originUrl.hostname;
    if (!isLoopbackHostname(originHost)) return false;
    // 严格比较：Origin 必须精确等于 http(s)://Host（协议 + 主机 + 端口三者一致）。
    const expected = (originUrl.protocol === "https:" ? "https://" : "http://") + req.headers.host;
    return origin === expected;
  }

  /** 仅接受 application/json（可带 charset）。 */
  function contentTypeAllowed(req) {
    const raw = req.headers["content-type"];
    if (typeof raw !== "string" || raw.length === 0) return false;
    const mediaType = raw.split(";", 1)[0].trim().toLowerCase();
    return mediaType === "application/json";
  }


  /** 读请求体；普通设置请求限制 16KB，图片提交使用更大的专用上限。 */
  function readBody(req, maxBytes = 16384) {
    // connection.rpc.intercept 已经完成 JSON 解码；保留同一 dispatch 逻辑时直接
    // 消费 payload，并仍执行大小边界检查，避免绕过旧 HTTP 路径的限制。
    if (Object.prototype.hasOwnProperty.call(req ?? {}, "body")) {
      const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      if (new TextEncoder().encode(raw).byteLength > maxBytes) return Promise.reject(new PayloadTooLargeError("请求体超过大小限制"));
      return Promise.resolve(raw);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const once = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const length = Number(req.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) {
        // Content-Length 已判定超限：立即拒绝以尽快返回 413，同时挂最小 drain listener
        // 并 resume 消费剩余请求体，避免未读字节残留在 socket 中破坏 keep-alive。
        // 不使用 destroy：让连接可安全复用。
        req.on("data", () => {});
        req.on("end", () => {});
        req.on("error", () => {});
        req.resume();
        once(reject, new PayloadTooLargeError("payload too large"));
        return;
      }
      const chunks = [];
      let total = 0;
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        if (settled) return;
        total += Buffer.byteLength(chunk);
        if (total > maxBytes) {
          once(reject, new PayloadTooLargeError("payload too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => once(resolve, chunks.join("")));
      req.on("error", (error) => once(reject, error));
    });
  }

  function responseDelivered(result) {
    if (result === false) return false;
    if (result !== null && typeof result === "object" && result.written === false) return false;
    return true;
  }
  

  return {
    sendJson,
    sendText,
    sendError,
    parseHost,
    isLoopbackHostname,
    sameOrigin,
    contentTypeAllowed,
    readBody,
    responseDelivered,
  };
}
