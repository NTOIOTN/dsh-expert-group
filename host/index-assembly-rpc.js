/**
 * 入口装配段 5（票据 21b · R4-21）：RPC HTTP 面、图片路由 wire/claim 状态与上传归一。
 *
 * 两个 claim 清理 effect 的注册描述按原顺序返回（claim 表 -> cleanup token 表）。
 *
 * @module dsh-expert-group/host/index-assembly-rpc
 */
import { toPngBytes, pngCopyName, effectiveModelRoute } from "../image-routing.js";
import { transcodeImageToPng } from "./image-transcode.js";
import { createRpcHttpSurface } from "./index-rpc-http.js";
import { createImageRouteWire } from "./index-image-route.js";
import { createImageRouteClaims } from "./index-image-claims.js";
import { createUploadNormalizer } from "./index-upload-normalize.js";

/**
 * 客户端图片提交的 32MiB JSON 上限由 host/rpc-transport 的传输预算统一持有
 * （bodyLimits.image），dispatch 通过 host.rpc.limitFor 读取，不复制第二个数字：
 * 上限要覆盖 base64 膨胀，同时仍由附件服务的图片限制兜底。
 */
const IMAGE_RPC_MAX_COUNT = 16;

/**
 * RPC 传输 + 图片路由校验 + 上传归一（票据 19）。
 *
 * 域模块分工：HTTP 面 / wire 校验 / claim 状态 / 上传归一。两个 claim 清理 effect 仍由入口
 * 按序登记。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleRpcSurface(state) {
  const { agents, subagents, webServer } = state.services;
  const { host, rpcErrorTracker } = state;

  const rpcHttp = createRpcHttpSurface({
    hostRpc: host.rpc,
    webServer,
    errorTracker: rpcErrorTracker,
  });
  state.rpcHttp = rpcHttp;
  Object.assign(state, rpcHttp);
  // wire 域与上传归一共享同一个 ValidationError 类身份：类由入口创建（RPC 400 映射与
  // 图片/路由请求共用），这里只传类本身，绝不重新声明（否则 mapRpcError 的 instanceof
  // 会退化成 500）。
  const imageRouteWire = createImageRouteWire({ ValidationError: state.ValidationError, effectiveModelRoute });
  state.imageRouteWire = imageRouteWire;
  Object.assign(state, imageRouteWire);

  const rpcClaims = createImageRouteClaims({
    agents,
    lineage: host.lineage,
    subagents,
    resolveMainImageRoute: imageRouteWire.resolveMainImageRoute,
  });
  state.rpcClaims = rpcClaims;
  Object.assign(state, rpcClaims);

  const registrations = [
    // 两个清理 effect 的注册点与顺序与迁移前完全一致（claim 表 -> cleanup token 表）。
    {
      kind: "effect",
      label: "dsh-expert-group: image route claims",
      factory: () => () => rpcClaims.clearRouteClaims(),
    },
    {
      kind: "effect",
      label: "dsh-expert-group: observer cleanup tokens",
      factory: () => () => rpcClaims.clearObserverCleanupTokens(),
    },
  ];

  const uploadNormalizer = createUploadNormalizer({
    ValidationError: state.ValidationError,
    // 附件服务是可选注入能力：取值函数在调用期解析当前绑定（与迁移前同一语义）。
    attachmentAccess: { getStore: () => state.attachmentStore },
    wire: imageRouteWire,
    imagePipeline: { toPngBytes, pngCopyName, transcodeImageToPng },
    abort: { createAbortError: state.createAbortError },
    limits: { maxCount: IMAGE_RPC_MAX_COUNT },
  });
  Object.assign(state, uploadNormalizer);

  return registrations;
}
