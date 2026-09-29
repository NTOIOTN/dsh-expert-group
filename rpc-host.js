/**
 * RPC 传输层契约。
 *
 * legacy HTTP 与 DSH Connection 必须共用同一个不感知传输细节的业务 dispatch；
 * 本模块只负责 Connection 一侧的 envelope、signal 与 transport details：
 *
 * - endpoint 校验（未知 endpoint 返回结构化 not-found）；
 * - 把业务 dispatch 的 (status, body) 结果转换为 Connection 的
 *   { ok: true, value } / { ok: false, error: { code, message, details } } 形状；
 * - 图片路由标记按 payload.action 推导（Connection 已由宿主完成浏览器认证，
 *   不再要求 HTTP 专用头）；
 * - 宿主 rpc.handle 不可用时（例如 DSH 0.1.5-rc.1 的 HostConnectionService
 *   register() 会经 Connection 自身 ctx 解析 owner.webServer），插件自持
 *   channel 路由仍要按公开 wire 契约收发 client-request / server-response，
 *   这两条 envelope 的纯函数也留在本模块，避免 HTTP 适配层复制契约。
 * - 自持 channel 路由在请求体超限时只读到有界前缀，无法再 JSON.parse 整份
 *   envelope；rpcId 恢复（rpcIdFromEnvelopeText）保持在同一模块，超限响应仍能
 *   精确回显关联 id，客户端不会把结构化错误当成无法关联的传输故障。
 *
 * 业务动作、认证、请求大小、ownership 与错误 code 由 index.js 的 dispatch 提供；
 * 本模块不复制任何业务逻辑，也不伪造 HTTP request/response。
 *
 * @module dsh-expert-group/rpc-host
 */

/**
 * 创建 Connection RPC handler。
 *
 * @param {object} options
 * @param {string} options.endpoint - 插件独占的 Connection endpoint 名。
 * @param {(body:object, signal:AbortSignal|undefined, respond:(status:number, body:object)=>void, options:{imageRequest:boolean})=>Promise<void>} options.dispatch
 *   传输无关的业务 dispatch；通过 respond 回调返回结果。
 * @returns {(endpoint:string, payload:object, signal:AbortSignal|undefined)=>Promise<object>}
 *   DSH Connection 的 handler 契约。
 */
export function createConnectionRpcHandler({ endpoint, dispatch } = {}) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new TypeError("createConnectionRpcHandler 需要非空 endpoint");
  }
  if (typeof dispatch !== "function") {
    throw new TypeError("createConnectionRpcHandler 需要 dispatch 函数");
  }
  return async function handleConnectionRpc(requestEndpoint, payload, signal) {
    if (requestEndpoint !== endpoint) {
      return { ok: false, error: { code: "not-found", message: "未知 RPC endpoint", details: {} } };
    }
    // 业务 dispatch 通过收集器返回 (status, body)；这里不构造 HTTP 替身。
    // 收集器 first-wins：Connection 没有"半写"能力，dispatch 收尾后再次 respond
    // （迟到回调或重复 send）必须被忽略，而不是覆盖已经决定的结果。
    let responded = false;
    let status = 500;
    let body;
    const respond = (nextStatus, nextBody) => {
      if (responded) return false;
      responded = true;
      status = nextStatus;
      body = nextBody;
      return true;
    };
    let failure;
    try {
      // 图片五个动作（上传判定、提交前复核、Observer 两阶段提交、失败清理、成功释放）都需要
      // 专用请求标记：Connection 由 action 推导，legacy HTTP 由 x-dsh-expert-group-image 头提供。
      // 五者共用同一 fail-closed 边界（缺少标记一律 400），因此这里必须同时识别全部动作名。
      const imageActions = [
        "image-route",
        "image-route-validate",
        "image-route-observer-commit",
        "image-route-observer-cancel",
        "image-route-observer-release",
      ];
      const imageRequest = imageActions.includes(payload?.action);
      await dispatch(payload, signal, respond, { imageRequest });
    } catch (error) {
      // dispatch 自身已经捕获业务错误；这里只兜底意外抛出的缺陷，避免悬挂 promise。
      failure = error;
    }
    // 已经响应过的请求按已发送结果收敛：传输层真实写入无法撤回，此时把后到的异常
    // 伪装成 internal 只会让客户端拿到与 HTTP 不同的第二个结果。未响应才兜底。
    if (responded !== true && failure !== undefined) {
      return {
        ok: false,
        error: {
          code: "internal",
          message: "内部错误，请查看服务端日志",
          details: {},
        },
      };
    }
    if (status < 200 || status >= 300 || body?.ok !== true) {
      const error = body?.error;
      return {
        ok: false,
        error: {
          code: typeof error?.code === "string" ? error.code : "internal",
          message: typeof error?.message === "string" ? error.message : "RPC 请求失败",
          details: error?.details !== null && typeof error?.details === "object" ? error.details : {},
        },
      };
    }
    return { ok: true, value: body };
  };
}

/** 无法从请求里读到合法 rpcId 时使用的占位 id；与宿主 rpc-host 同名常量保持同形。 */
const INVALID_RPC_ID = "invalid-request";

/** endpoint 各段允许的字符；与宿主 ENDPOINT_SEGMENT_PATTERN 保持同一规则。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/**
 * 从 channel 前缀路径推出 endpoint。
 *
 * 插件自持 channel 路由必须和宿主 rpcFetchHandler 用同一套段规则判定 endpoint：
 * 空段、`.`、`..` 与非法字符一律不认，避免路径穿越或把 `/rpc/x` 当成别的 endpoint。
 *
 * @param {string} channel - channel 前缀，例如 "/dsh-expert-group"。
 * @param {string} pathname - 请求路径。
 * @returns {string|undefined} 去掉前缀后的 endpoint；不匹配时返回 undefined。
 */
export function channelEndpointFromPath(channel, pathname) {
  if (typeof channel !== "string" || channel.length === 0) return void 0;
  if (typeof pathname !== "string" || !pathname.startsWith(channel + "/")) return void 0;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."
    || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return void 0;
  }
  return endpoint;
}

/**
 * 校验一条已解码的 client-request envelope。
 *
 * 只接受 DSH Connection 公开 wire 形状 { type, rpcId, method, payload }；
 * method 必须等于按请求路径推出的 endpoint，否则同一 channel 会被用来旁路
 * 其它 endpoint。失败时沿用宿主的 gateway/bad-request code 与 rpcId 回显语义。
 *
 * @param {unknown} body - 已 JSON 解码的请求体。
 * @param {string} endpoint - 由请求路径推出的 endpoint。
 * @returns {object} ok:true 时带 rpcId 与 payload；否则带 code/message 的结构化失败。
 */
export function readClientRequestEnvelope(body, endpoint) {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body : undefined;
  // rpcId 缺失时仍要回一个稳定 id，客户端才能把响应与请求对上，而不是在解析阶段抛错。
  const rpcId = typeof record?.rpcId === "string" && record.rpcId.length > 0 ? record.rpcId : INVALID_RPC_ID;
  if (record === undefined || record.type !== "client-request" || typeof record.method !== "string") {
    return { ok: false, rpcId, code: "gateway/bad-request", message: "invalid client-request message" };
  }
  if (record.method !== endpoint) {
    return {
      ok: false,
      rpcId,
      code: "gateway/bad-request",
      message: "method " + JSON.stringify(record.method) + " does not match endpoint " + JSON.stringify(endpoint),
    };
  }
  return { ok: true, rpcId, payload: record.payload };
}

/** 顶层 rpcId 键名；只认字面量键，与 readClientRequestEnvelope 读 record.rpcId 的判定一致。 */
const RPC_ID_KEY_TEXT = "rpcId";

/**
 * 顶层字段扫描窗口（字符数）。
 *
 * 自持 channel 路由超限时只保留有界前缀：host/rpc-transport.js 的
 * BOUNDED_PREFIX_LIMIT = RPC_JSON_BODY_LIMIT(16384) + 8192 = 24576 字符。窗口取 32KiB，
 * 保证**真实前缀永远不会被窗口截断**（窗口外的 key 根本不存在于前缀里）；它的作用
 * 只是兜住 index.js 在前缀缺失时 JSON.stringify 整个请求体的回退路径（图片路由可达
 * 32MiB），使扫描成本恒有上界。上游若把 BOUNDED_PREFIX_LIMIT 调大过本窗口，需同步调整。
 */
const RPC_ID_SCAN_WINDOW = 32768;

/** JSON 允许的四种空白；键/值分隔判定只跳过它们。 */
function isJsonSpace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * 从一个 JSON 字符串的起始引号跳到结束引号之后。
 *
 * 通用扫描规则：反斜杠后的一个字符一律跳过（`\\`、`\"`、`\n`、`\uXXXX` 都成立），
 * 因此 payload 里的普通转义不会中断扫描，也不会被误判成引号边界。
 *
 * @param {string} text - 已读取的文本。
 * @param {number} start - 起始引号下标。
 * @param {number} limit - 允许扫描到的不含上界。
 * @returns {number} 结束引号的下一位；窗口内读不到结束引号（前缀被截断）时返回 -1。
 */
function skipJsonString(text, start, limit) {
  let index = start + 1;
  while (index < limit) {
    const char = text[index];
    if (char === "\\") { index += 2; continue; }
    if (char === '"') return index + 1;
    index += 1;
  }
  return -1;
}

/**
 * 解码一个 rpcId 字符串字面量。
 *
 * rpcId 只可能是普通标识符，因此只认 \" 与 \\ 两种转义；其它 JSON 转义（含 \uXXXX）
 * 按不可信处理并 fail-closed，避免回显一个与 readClientRequestEnvelope 解析结果
 * 不一致的 id。前缀在字符串中间结束时同样返回占位 id。
 *
 * @param {string} text - 已读取的文本。
 * @param {number} start - 值的起始引号下标。
 * @returns {string} 可回显的 rpcId，或 INVALID_RPC_ID。
 */
function decodeRpcIdValue(text, start) {
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const next = text[index + 1];
      if (next !== '"' && next !== "\\") return INVALID_RPC_ID;
      value += next;
      index += 2;
      continue;
    }
    if (char === '"') return value.length > 0 ? value : INVALID_RPC_ID;
    value += char;
    index += 1;
  }
  // 前缀在 rpcId 字符串中间结束：没有完整的值可回显。
  return INVALID_RPC_ID;
}

/**
 * 从（可能被截断的）client-request 文本里恢复 rpcId。
 *
 * 请求体超限时传输层只保留有界前缀，无法 JSON.parse 整份 envelope；但客户端要求
 * server-response 精确回显 rpcId，否则会把结构化错误退化成无法关联的传输故障。
 *
 * 这里不再取文本里第一个 `"rpcId":"…"`：payload 先于顶层字段序列化且 payload 内嵌
 * 同名 rpcId 时，那会把关联 id 回显错。改为在**头部固定窗口**内做一次结构扫描，只在
 * **顶层对象的第一层**（depth === 1）匹配键名，嵌套容器一律忽略；扫描在任何时刻被
 * 截断（窗口/前缀在字符串中间结束、顶层键名不是字面量、值不是字符串）都 fail-closed
 * 返回占位 id——宁可让客户端拿到 invalid-request，也不能回显一个错误的关联 id。
 *
 * @param {unknown} text - 已读取的请求体前缀（可以为空或被截断）。
 * @returns {string} 可回显的 rpcId；无法确定顶层字段时返回 invalid-request 占位 id。
 */
export function rpcIdFromEnvelopeText(text) {
  if (typeof text !== "string" || text.length === 0) return INVALID_RPC_ID;
  const limit = Math.min(text.length, RPC_ID_SCAN_WINDOW);
  // depth：顶层 envelope 对象内部为 1；payload 等嵌套对象/数组继续加深，因此
  // payload 内嵌的 rpcId 因 depth > 1 被忽略，只有信封顶层的 rpcId 会命中。
  let depth = 0;
  let index = 0;
  while (index < limit) {
    const char = text[index];
    if (char === "{" || char === "[") { depth += 1; index += 1; continue; }
    if (char === "}" || char === "]") { depth -= 1; index += 1; continue; }
    if (char !== '"') { index += 1; continue; }
    const end = skipJsonString(text, index, limit);
    // 窗口内读不到结束引号：无法判定这个 token 的边界，后续结构都不可信。
    if (end === -1) return INVALID_RPC_ID;
    // 键位置判定：字符串结束后第一个非空白字符是冒号，才是对象的键；否则是字符串值。
    let cursor = end;
    while (cursor < limit && isJsonSpace(text[cursor])) cursor += 1;
    const isKey = cursor < limit && text[cursor] === ":";
    if (isKey && depth === 1 && text.slice(index + 1, end - 1) === RPC_ID_KEY_TEXT) {
      // 值必须是字符串字面量：readClientRequestEnvelope 也只把字符串 rpcId 当关联 id，
      // 两者判定必须同源，否则截断回显与解析后的语义会分叉。键已确定在窗口内，
      // 其值紧随其后，因此这里按文本长度推进（不再受扫描窗口约束）。
      let valueStart = cursor + 1;
      while (valueStart < text.length && isJsonSpace(text[valueStart])) valueStart += 1;
      if (valueStart >= text.length || text[valueStart] !== '"') return INVALID_RPC_ID;
      return decodeRpcIdValue(text, valueStart);
    }
    index = end;
  }
  return INVALID_RPC_ID;
}

/**
 * 把 Connection handler 的返回值组装成 server-response envelope。
 *
 * 客户端（DSH createWebConnectionRpc）要求 error.details 一定是对象，因此这里
 * 与 createConnectionRpcHandler 一样把缺失/非法 details 归一成空对象，不递归转换 value。
 *
 * @param {string} rpcId - 请求携带的关联 id，原样回显。
 * @param {unknown} result - Connection handler 的 { ok:true, value } / { ok:false, error } 结果。
 * @returns {object} 宿主公开的 server-response envelope。
 */
export function writeServerResponseEnvelope(rpcId, result) {
  const record = result !== null && typeof result === "object" ? result : undefined;
  if (record?.ok === true) {
    return { type: "server-response", rpcId, result: { ok: true, value: record.value } };
  }
  const error = record?.error;
  return {
    type: "server-response",
    rpcId,
    result: {
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "internal",
        message: typeof error?.message === "string" ? error.message : "RPC 请求失败",
        details: error?.details !== null && typeof error?.details === "object" ? error.details : {},
      },
    },
  };
}
