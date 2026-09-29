/**
 * Host 关注点模块：RPC transport 接线与传输加固。
 *
 * expand 阶段只接管"传输能力探测 + Connection 注册生命周期"这两个此前隐含在
 * apply 里的步骤；业务 dispatch、HTTP envelope 与 legacy route 仍留在 index.js，
 * 任务 06 再收缩。模块不读取全局单例，所有依赖由调用方注入。
 *
 * 除接线外，本模块还是两条传输共用的加固 seam：请求体的按类型字节预算与安全
 * 响应收尾都从这里导出。legacy exact route、自持 channel 路由与 Connection 通道
 * 接线后共用同一预算选择、同一结构化错误 code 与同一"最多写一次响应"的收敛规则。
 *
 * @module dsh-expert-group/host/rpc-transport
 */
import { StringDecoder } from "node:string_decoder";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 探测宿主是否提供可用的 Connection RPC 能力。
 *
 * 只有"注入上下文确实带 connection 属性"时才进入判定；属性存在但 API 缺失或
 * 读取抛错都返回 unsupported，调用方必须 fail-closed，不能回退到未经认证的 legacy。
 *
 * @param {object} connectionCtx - ctx.inject(["connection"]) 回调收到的上下文。
 * @returns {{status:"absent"|"unsupported"|"available", rpc?:object, reason?:string}}
 */
export function probeConnectionRpc(connectionCtx) {
  const hasConnection = connectionCtx !== null && connectionCtx !== undefined
    && (Object.prototype.hasOwnProperty.call(connectionCtx, "connection") || "connection" in Object(connectionCtx));
  if (!hasConnection) return { status: "absent", reason: "connection service is not injected" };
  let rpc;
  try {
    rpc = connectionCtx?.connection?.rpc;
  } catch (error) {
    return { status: "unsupported", reason: "connection rpc unavailable: " + describeError(error) };
  }
  if (typeof rpc?.handle !== "function") {
    return { status: "unsupported", reason: "connection rpc handle API unavailable" };
  }
  return { status: "available", rpc };
}

/**
 * 创建一次 Connection 注册的生命周期记录。
 *
 * 释放优先跟随 Connection 服务生命周期（connectionCtx.effect）；宿主未提供该
 * 能力时回落到插件自身 fiber（fallbackEffect），保证卸载一定释放 handle。
 * release 幂等：重复释放只生效一次，返回值可观察。
 *
 * @param {object} options
 * @param {object} options.connectionCtx
 * @param {Function} [options.fallbackEffect] - 插件自身 ctx.effect。
 * @param {Function} options.release - 实际释放 handle 的回调。
 * @param {string} [options.label] - effect 标签。
 */
export function createConnectionRegistration({ connectionCtx, fallbackEffect, release, label } = {}) {
  if (typeof release !== "function") throw new TypeError("createConnectionRegistration 需要 release 回调");
  const effectLabel = typeof label === "string" && label.length > 0 ? label : "dsh-expert-group: connection rpc channel";
  let released = false;
  const runRelease = () => {
    if (released) return false;
    released = true;
    release();
    return true;
  };
  return Object.freeze({
    get released() { return released; },
    effectLabel,
    /** 挂到可用 effect 作用域；返回 "connection" | "plugin"。 */
    attach() {
      if (released) throw new Error("connection registration 已释放，不能再次 attach");
      if (typeof connectionCtx?.effect === "function") {
        connectionCtx.effect(() => runRelease, effectLabel);
        return "connection";
      }
      if (typeof fallbackEffect === "function") {
        fallbackEffect(() => runRelease, effectLabel);
        return "plugin";
      }
      throw new Error("没有可用的 effect 作用域，无法保证 Connection 注册被释放");
    },
    release: runRelease,
  });
}

// ── 传输加固：请求体预算、早停与响应收尾 ─────────────────────────────────
/**
 * 普通 JSON RPC 请求体上限（16KiB）。
 *
 * 与历史 `readBody` 默认值一致；导出为单一来源后，legacy 读 body、Connection
 * payload 字节检查与自持 channel 路由不必各自硬编码同一个数字。
 */
export const RPC_JSON_BODY_LIMIT = 16384;

/**
 * image-route 请求体上限（32MiB）。
 *
 * 图片以 base64 传输，必须保留更大预算；但只有请求被判定为图片路由时才使用，
 * 普通 JSON 请求不得借此放大读取窗口。
 */
export const RPC_IMAGE_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * settings-commit 请求体上限（8MiB）。
 *
 * 设置保存是"整份候选"提交：六个角色的自定义提示词各自可达 32,000 个 grapheme，
 * 因此候选体积必须按 **UTF-8 字节**而不是按「grapheme 数 × 固定字节数」估算——
 * grapheme 与字节不是一回事：
 * - 一个可见字符可能是 1 字节（ASCII）到 4 字节（CJK/emoji 基础码位）；
 * - 组合簇（例如 ZWJ 家庭 emoji，单个可见字符由 7 个 code point 组成）在 UTF-8 下
 *   约 25 字节，**组合簇的字节数没有固定上界**（用户完全可以输入更长的 ZWJ 序列）。
 *
 * 实测：六角色各 32,000 个中文 grapheme 约 0.58MB，六角色各 32,000 个家庭 ZWJ
 * emoji 约 4.8MB。8MiB 覆盖这两个常见形态并留出余量，同时仍远小于图片预算，因此
 * 普通请求不会因为这一档而放大读取窗口；真正极端的组合簇（例如每个可见字符数百
 * 字节）仍会被这一档拒绝为结构化 413，而不是被静默截断。
 */
export const RPC_SETTINGS_COMMIT_BODY_LIMIT = 8 * 1024 * 1024;

/**
 * 超限错误与声明探测共用的有界前缀长度。
 *
 * 插件客户端把 payload.action 放在请求体首位，合法声明必然落在窗口内；窗口有界则
 * 保证普通请求不会为了探测而多读字节，也不会被正文深处的同名文本放大读取预算。
 * 前缀同时用于让自持 channel 路由恢复 rpcId，因此它必须覆盖最大的 action 声明长度
 * （settings-commit 比 image-route 更长）加上 JSON 空白余量。
 */
const BOUNDED_PREFIX_LIMIT = RPC_JSON_BODY_LIMIT + 8192;

/**
 * 请求体前缀里的 action 声明：只放大 JSON 空白，action 值本身是小写字面量加连字符。
 *
 * 只取**第一个**出现的字面量：客户端（含旧版 bundle）总把 payload.action 放在请求体
 * 首位——图片路由是 `{action,sessionId,text,images}`，自持 channel 是
 * `{type,rpcId,method,payload:{action,...}}`——因此第一个匹配就是本次请求的动作声明。
 * 这一点是加固必需：用户正文里出现的同名文本（例如消息内容里写了
 * `"action":"settings-commit"`）绝不能改写传输预算判定。
 */
const RPC_ACTION_DECLARATION = /"action"\s*:\s*"([a-z0-9-]*)"/u;

/** 在响应对象上登记一次性 error 吸收器，避免重复登记同一个响应。 */
const responsesWithAbsorber = new WeakSet();

/** 已经成功收尾过的响应；即使替身没有 headersSent 也不能二次写。 */
const finalizedResponses = new WeakSet();

/**
 * 请求体超限错误。
 *
 * code/status 与既有 mapRpcError 的输出一致（413 payload-too-large），因此 legacy
 * HTTP 可以继续使用同一个结构化错误信封；自持 channel 路由可以用 error.prefix
 * 恢复 rpcId 后回 server-response，两条传输的错误 code 仍然一致。
 */
export class RpcBodyTooLargeError extends Error {
  /**
   * @param {object} [options]
   * @param {number} [options.limit] - 触发拒绝的预算（字节）。
   * @param {string} [options.prefix] - 已读取的有界请求体前缀。
   * @param {string} [options.message]
   */
  constructor({ limit = RPC_JSON_BODY_LIMIT, prefix = "", message = "请求体超过允许上限" } = {}) {
    super(message);
    this.name = "RpcBodyTooLargeError";
    this.code = "payload-too-large";
    this.status = 413;
    this.limit = limit;
    this.prefix = prefix;
  }
}

/**
 * 识别请求体超限错误。
 *
 * 同时接受 name/code 判定：index.js 目前持有自己的 PayloadTooLargeError，接线时
 * 只需把该错误替换成本模块的类（或共用 code），不需要改 mapRpcError 的形状。
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRpcBodyTooLargeError(error) {
  return error instanceof RpcBodyTooLargeError
    || (error?.code === "payload-too-large" && error?.status === 413);
}

/**
 * 构造一次请求取消错误。
 *
 * 客户端在读完 body 前断开时以 AbortError/ABORT_ERR 收敛，调用方的 mapRpcError
 * 据此映射 499 gateway/cancelled，而不是把 socket 错误当成 500 internal。
 *
 * @param {string} [message]
 * @returns {Error}
 */
export function createRpcAbortError(message = "请求已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * 从一份（可能被截断的）请求体前缀里读出本次请求声明的 action。
 *
 * 只做文本探测：真正的 action 契约校验仍在业务 dispatch 内部。误判最坏只改变
 * 读取窗口大小，不会绕过认证、ownership 或任何业务校验。
 *
 * @param {unknown} text
 * @returns {string|undefined} 声明的小写 action；前缀里没有声明时返回 undefined。
 */
export function declaredRpcActionFromText(text) {
  if (typeof text !== "string") return void 0;
  const match = RPC_ACTION_DECLARATION.exec(text);
  return match === null ? void 0 : match[1];
}

/**
 * 判断一份（可能被截断的）请求体前缀是否声明了图片路由。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isImageRpcBodyDeclared(text) {
  return declaredRpcActionFromText(text) === "image-route";
}

/**
 * 判断一份（可能被截断的）请求体前缀是否声明了 settings-commit。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSettingsCommitRpcBodyDeclared(text) {
  return declaredRpcActionFromText(text) === "settings-commit";
}

/**
 * 按请求前缀声明的 action 选择读取预算。
 *
 * 三种预算互不重叠：普通 16KiB、settings-commit 8MiB、image-route 32MiB。
 * **已解析的 action 对预算优先**：只有 image-route 能使用图片预算，settings-commit
 * 与其它 action 各自收敛到自己的档位。options.imageRequest 是 legacy 专用头那样的
 * 传输补丁，只在前缀**尚未声明任何 action** 时作为回退（保持旧客户端"只带头"的历史
 * 行为），绝不能把一个已声明的 settings-commit 提升到 32MiB。
 *
 * @param {unknown} prefix - 有界请求体前缀。
 * @param {{imageRequest?:boolean}} [options] - 传输层图片标记（legacy 专用头）。
 * @returns {number} 字节预算。
 */
export function rpcBodyLimitForDeclaredText(prefix, { imageRequest = false } = {}) {
  const action = declaredRpcActionFromText(prefix);
  if (action !== void 0) return rpcBodyLimitFor({ action });
  return imageRequest === true ? RPC_IMAGE_BODY_LIMIT : RPC_JSON_BODY_LIMIT;
}

/**
 * 选择一次请求的读取预算。
 *
 * 预算由**已解析的 action** 决定，imageRequest（legacy 专用头）只是 action 尚未解析
 * 出来时的回退：
 * - image-route 是唯一被允许使用图片预算的动作；
 * - settings-commit 提交整份设置候选（六个角色各可达 32,000 grapheme 的提示词覆盖），
 *   体积按 UTF-8 字节计量且组合簇没有固定上界，因此有独立档位；超限仍是结构化 413，
 *   绝不截断；
 * - 其它 action（含未知/非字符串声明）一律最小预算，图片头不得放大读取窗口。
 *
 * @param {object} [options]
 * @param {boolean} [options.imageRequest] - 传输是否已声明图片请求（legacy 专用头）。
 * @param {unknown} [options.action] - 已解码 payload 的 action（Connection 由 payload 推导）。
 * @returns {number} 字节预算。
 */
export function rpcBodyLimitFor({ imageRequest = false, action } = {}) {
  if (action !== void 0 && action !== null) {
    if (action === "image-route") return RPC_IMAGE_BODY_LIMIT;
    if (action === "settings-commit") return RPC_SETTINGS_COMMIT_BODY_LIMIT;
    return RPC_JSON_BODY_LIMIT;
  }
  return imageRequest === true ? RPC_IMAGE_BODY_LIMIT : RPC_JSON_BODY_LIMIT;
}

/** 超限后 drain 剩余字节：不使用 destroy，让连接可以安全复用。 */
function drainRequest(req) {
  req.on("data", () => {});
  req.on("end", () => {});
  req.on("error", () => {});
  req.resume?.();
}

/** 已解码 body（Connection intercept）也走同一预算，避免绕过旧 HTTP 限制。 */
function readProvidedBody(value, declaredImage) {
  let raw;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value ?? {});
  } catch (error) {
    // 不可序列化的 payload 属于客户端输入问题，交给调用方按既有错误路径映射。
    return Promise.reject(error);
  }
  const prefix = raw.slice(0, BOUNDED_PREFIX_LIMIT);
  // 已解码 payload 的 action 就写在前缀里，因此预算选择与流式读取同源：已解析的
  // action 优先于传输图片标记（settings-commit 不会被图片头提升到 32MiB）。
  const limit = rpcBodyLimitForDeclaredText(prefix, { imageRequest: declaredImage });
  if (Buffer.byteLength(raw) > limit) return Promise.reject(new RpcBodyTooLargeError({ limit, prefix }));
  return Promise.resolve(raw);
}

/**
 * 流式读取请求体，按预算早停。
 *
 * 普通 JSON 请求在超过 16KiB 时立即停止读取并拒绝，不再为普通请求分配图片级别的
 * 32MiB 缓冲区；每读到一个 chunk 都按累积的有界前缀重算预算：声明了更大的 action
 * （settings-commit 8MiB / image-route 32MiB）就升档，声明了更小的 action 就降档
 * （伪造/过期的图片专用头不能让一次 settings 提交按 32MiB 读完）。超限与断开都会
 * drain 剩余字节，避免 keep-alive socket 残留未读数据。
 *
 * 解码边界：req.setEncoding 只是可选调用（Connection payload 替身与宿主注入的请求
 * 形状都没有它），因此 data 事件不一定已经是字符串。原始字节分片一律交给
 * StringDecoder 跨 chunk 保留不完整序列，end 时冲刷尾部残字节——逐 chunk 的
 * String(chunk) 会在多字节字符的字节中间插入 U+FFFD，破坏 JSON 文本与 rpcId 回显。
 */
function readStreamedBody(req, declaredImage) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    // 流式 utf8 解码器：只对 Buffer/TypedArray 形态的 chunk 生效，字符串 chunk 走原语义。
    const decoder = new StringDecoder("utf8");
    // 首个 data 事件之前的回退预算；每个 chunk 都会按有界前缀重算（见 onData）。
    let limit = declaredImage ? RPC_IMAGE_BODY_LIMIT : RPC_JSON_BODY_LIMIT;
    let settled = false;
    // 有界前缀：小请求常常一次 data 就超限，超限的那一块也必须进入前缀，否则调用方
    // 无法回显 rpcId。前缀长度固定上限，绝不随请求体增长。
    let head = "";
    const collectHead = (text) => {
      const room = BOUNDED_PREFIX_LIMIT - head.length;
      if (room > 0) head += text.slice(0, room);
    };

    const onData = (chunk) => {
      if (settled) return;
      let text;
      let bytes;
      if (typeof chunk === "string") {
        // 宿主 setEncoding 生效：chunk 已按 utf8 解码。解码器里若有未冲刷的残字节
        // （两种形态混流时的防御分支，真实流不会混用），先补回文本保证顺序，其字节数
        // 在原始分片到达时已经计过账，这里只统计字符串本身的字节数。
        text = decoder.end() + chunk;
        bytes = Buffer.byteLength(chunk);
      } else if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
        // 无 setEncoding：原始字节。byteLength 直接取分片长度，与解码结果无关，
        // 因此不完整字符被解码器扣下时预算仍然按真实收到的字节增长。
        text = decoder.write(chunk);
        bytes = chunk.byteLength;
      } else {
        // 非常规 chunk（自定义 toString 的替身）：退回历史语义，不让解码器抛出
        // TypeError 把一次 RPC 变成传输层 500。
        text = String(chunk);
        bytes = Buffer.byteLength(text);
      }
      // 前缀先于判定累积：有界前缀里的 action 声明是权威预算来源，它既能升档
      // （16KiB → settings-commit 8MiB / image-route 32MiB），也能在伪造或过期的
      // 图片专用头下**降档**（32MiB → settings-commit 8MiB）；前缀长度固定上限，
      // 绝不随请求体增长。
      collectHead(text);
      limit = rpcBodyLimitForDeclaredText(head, { imageRequest: declaredImage });
      total += bytes;
      if (total > limit) {
        drainRequest(req);
        finish(reject, new RpcBodyTooLargeError({ limit, prefix: head }));
        return;
      }
      chunks.push(text);
    };
    // end 时先冲刷解码器尾部残字节，再拼接受限的分片文本，保证 body 与整段解码一致。
    const onEnd = () => finish(resolve, chunks.join("") + decoder.end());
    const onError = (error) => finish(reject, error);
    const onAborted = () => {
      const error = createRpcAbortError();
      // body 尚未完成时仍保留有界前缀，调用方可以回显 client-request 的 rpcId。
      error.prefix = head;
      finish(reject, error);
    };
    const onClose = () => {
      // close 也会在正常 body 读完后触发；只有未完整读取才算客户端提前断开。
      if (req.complete === true) return;
      const error = createRpcAbortError();
      error.prefix = head;
      finish(reject, error);
    };
    const cleanup = () => {
      req.removeListener?.("data", onData);
      req.removeListener?.("end", onEnd);
      req.removeListener?.("error", onError);
      req.removeListener?.("aborted", onAborted);
      req.removeListener?.("close", onClose);
    };
    function finish(settle, value) {
      if (settled) return;
      settled = true;
      cleanup();
      settle(value);
    }

    // content-length 已超过图片上限时任何请求类型都不可能合法：立即拒绝并 drain，
    // 不为一个必然失败的请求分配缓冲区。
    const contentLength = Number(req.headers?.["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > RPC_IMAGE_BODY_LIMIT) {
      drainRequest(req);
      finish(reject, new RpcBodyTooLargeError({ limit: RPC_IMAGE_BODY_LIMIT, prefix: "" }));
      return;
    }
    if (req.aborted === true) {
      finish(reject, createRpcAbortError());
      return;
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
    // 请求对象提供 setEncoding 时按 utf8 取字符串分片（历史 readBody 语义）；缺失时
    // 分片保持 Buffer，由上面 onData 里的 StringDecoder 负责跨 chunk 的字符边界。
    req.setEncoding?.("utf8");
  });
}

/**
 * 读取一次 RPC 请求体，并按请求类型选择字节预算。
 *
 * 加固点（相对历史 readBody）：
 * 1. 普通 JSON 请求超过 16KiB 立即停止读取并拒绝，不再为普通请求分配 32MiB 级别
 *    的缓冲区；只有前缀声明了 image-route 才升级到图片预算。
 * 2. 超限与断开都会 drain 剩余字节，连接可以安全复用。
 * 3. 客户端在读完前断开时以 AbortError（ABORT_ERR）拒绝，调用方映射 499 而不是 500。
 *
 * @param {object} req - Node IncomingMessage 形状；带已解码 `body` 的 Connection
 *   payload 替身同样受同一预算约束。
 * @param {object} [options]
 * @param {boolean} [options.imageRequest] - 传输是否已确定这是图片请求。
 * @returns {Promise<string>} 原始请求体文本。
 * @throws {RpcBodyTooLargeError} 超过所选预算。
 */
export function readRpcRequestBody(req, options = {}) {
  const declaredImage = (options ?? {}).imageRequest === true;
  if (req !== null && typeof req === "object" && Object.prototype.hasOwnProperty.call(req, "body")) {
    return readProvidedBody(req.body, declaredImage);
  }
  if (req === null || typeof req !== "object" || typeof req.on !== "function") {
    return Promise.reject(new TypeError("readRpcRequestBody 需要可读的请求对象"));
  }
  return readStreamedBody(req, declaredImage);
}

/** 在响应对象上登记一次性 error 吸收器：断开后的写入错误不能冒泡成未处理异常。 */
function absorbResponseErrors(res) {
  if (res === null || typeof res !== "object" || typeof res.on !== "function") return;
  if (responsesWithAbsorber.has(res)) return;
  responsesWithAbsorber.add(res);
  res.on("error", () => {});
}

/**
 * 响应或其底层 socket 是否已销毁。
 *
 * 客户端断开后 socket 先被销毁、响应对象可能还没标记 end；此时写入只会产生被丢弃
 * 的字节与一次 error 事件，因此收尾必须直接判定为不可写。
 */
function isResponseDestroyed(res) {
  if (res === null || typeof res !== "object") return true;
  if (res.destroyed === true) return true;
  let socket;
  try {
    socket = res.socket;
  } catch {
    // 读取 socket 失败不改变可写性判定，交由后续写入的 try/catch 收敛。
    return false;
  }
  return socket !== null && typeof socket === "object" && socket.destroyed === true;
}

/**
 * 响应是否已经收尾：headers 已发出、已 end、或连接已销毁，此时绝不能再写 header。
 *
 * @param {unknown} res
 * @returns {boolean} true 表示不能再写；非对象响应同样视为不可写。
 */
export function isRpcResponseSettled(res) {
  if (res === null || typeof res !== "object") return true;
  return res.headersSent === true
    || res.writableEnded === true
    || res.writableFinished === true
    || res.finished === true
    || isResponseDestroyed(res);
}

/**
 * 安全收尾一个 RPC HTTP 响应：最多写一次 header 与 body，任何写入异常都被吸收。
 *
 * 返回可观察结果而不是抛出。调用方（legacy exact route、自持 channel 路由、fence
 * 拒绝）在客户端已断开、响应已结束或 socket 已销毁时不能二次写 header，也不能把
 * ERR_HTTP_HEADERS_SENT / ERR_STREAM_WRITE_AFTER_END / EPIPE 变成未处理的 rejection。
 *
 * @param {object} res - ServerResponse 形状。
 * @param {number} status - HTTP 状态码。
 * @param {string|object} body - 字符串按 text/plain 原样写，其它按 JSON 信封写。
 * @param {object} [options]
 * @param {object} [options.headers] - 追加/覆盖的响应头。
 * @returns {{written:boolean, reason:"written"|"already-settled"|"destroyed"|"serialize-failed"|"write-failed"}}
 */
export function finalizeRpcResponse(res, status, body, { headers } = {}) {
  const isText = typeof body === "string";
  if (isRpcResponseSettled(res) || finalizedResponses.has(res)) {
    return { written: false, reason: isResponseDestroyed(res) ? "destroyed" : "already-settled" };
  }
  absorbResponseErrors(res);
  let payload;
  try {
    payload = isText ? body : JSON.stringify(body);
  } catch {
    // 响应体不可序列化（例如循环引用）：只报告失败，绝不抛出。
    return { written: false, reason: "serialize-failed" };
  }
  if (payload === undefined) payload = "";
  const baseHeaders = isText
    ? { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    : { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  try {
    res.writeHead(status, { ...baseHeaders, ...(headers ?? {}) });
    res.end(payload);
  } catch {
    // socket 竞态（已销毁/已 end）只影响本次响应，不能再次抛出。
    return { written: false, reason: "write-failed" };
  }
  finalizedResponses.add(res);
  return { written: true, reason: "written" };
}

/**
 * RPC transport 关注点模块。
 *
 * @param {object} options
 * @param {string} options.path - legacy exact route 路径。
 * @param {string} options.channel - Connection 逻辑频道。
 * @param {string} options.endpoint - Connection endpoint 名。
 */
export function createRpcTransportModule({ path, channel, endpoint } = {}) {
  for (const [name, value] of [["path", path], ["channel", channel], ["endpoint", endpoint]]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("createRpcTransportModule 需要非空 " + name);
    }
  }
  return Object.freeze({
    path,
    channel,
    endpoint,
    probe: probeConnectionRpc,
    createRegistration: (options) => createConnectionRegistration(options),
    // 传输加固 seam：index.js 的 legacy route 与自持 channel 路由都从这里取，
    // 保证两条传输共用同一预算选择与同一个不会二次写响应的收尾函数。
    // bodyLimits 的键集是已锁定的历史契约（恰好 json/image 两档），
    // settings-commit 档位不在这里新增键，而是通过下面的 limitFor 暴露。
    bodyLimits: Object.freeze({ json: RPC_JSON_BODY_LIMIT, image: RPC_IMAGE_BODY_LIMIT }),
    readBody: readRpcRequestBody,
    // 业务 dispatch 的已解码 payload 字节检查与传输层读取共用同一预算选择函数
    // （普通 16KiB / settings-commit 8MiB / image-route 32MiB），两条传输与两层
    // 检查因此不可能各自漂移出一个不同的上限。
    limitFor: rpcBodyLimitFor,
    finalizeResponse: finalizeRpcResponse,
    isResponseSettled: isRpcResponseSettled,
    isBodyTooLarge: isRpcBodyTooLargeError,
    describe: () => ({ path, channel, endpoint }),
    dispose() {},
  });
}
