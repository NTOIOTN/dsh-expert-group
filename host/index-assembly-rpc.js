/**
 * 入口装配段 5（票据 21b · R4-21）：RPC HTTP 面、图片路由 wire/claim 状态、上传归一、
 * 模板计划与持久化、fan-out RPC 只读解析、手动派发提交。
 *
 * 两个 claim 清理 effect 的注册描述按原顺序返回（claim 表 -> cleanup token 表）。
 *
 * @module dsh-expert-group/host/index-assembly-rpc
 */
import { toPngBytes, pngCopyName, effectiveModelRoute } from "../image-routing.js";
import { FANOUT_TEMPLATE_STORE_KEY, persistDomainEntry, normalizeTemplateDocumentEntries } from "../storage.js";
import { transcodeImageToPng } from "./image-transcode.js";
import { validateSubmitInput } from "../fanout.js";
import { createRpcHttpSurface } from "./index-rpc-http.js";
import { createImageRouteWire } from "./index-image-route.js";
import { createImageRouteClaims } from "./index-image-claims.js";
import { createUploadNormalizer } from "./index-upload-normalize.js";
import { createFanoutTemplatePlanner } from "./index-template-plan.js";
import { createFanoutTemplateStore } from "./index-template-store.js";
import { createFanoutRpcReads } from "./index-fanout-rpc.js";
import { createManualFanoutDispatch } from "./index-manual-dispatch.js";

/**
 * 客户端图片提交的 32MiB JSON 上限由 host/rpc-transport 的传输预算统一持有
 * （bodyLimits.image），dispatch 通过 host.rpc.limitFor 读取，不复制第二个数字：
 * 上限要覆盖 base64 膨胀，同时仍由附件服务的图片限制兜底。
 */
const IMAGE_RPC_MAX_COUNT = 16;

/**
 * RPC 传输 + 图片路由校验 + 上传归一 + 模板计划（票据 19）。
 *
 * 域模块分工：HTTP 面 / wire 校验 / claim 状态 / 上传归一 / 模板规划 / 模板持久化 /
 * 手动派发提交 / fan-out RPC 只读解析。两个 claim 清理 effect 仍由入口按序登记。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleRpcSurface(state) {
  const { agents, subagents, webServer } = state.services;
  const { host, rpcErrorTracker, tableEntries } = state;

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

  // ═══════════════════════════════════════════════════════════════════════
  // 手动派发与任务模板（票据 28，服务端部分）
  //
  // 设计边界（与规格书 §6 一致）：
  // - 只新增 RPC 入口，不复制任何派发逻辑：单专家 / fan-out / 模板派发最终都走与 fanout
  //   工具完全相同的 submitFanoutTask → manager.submit 路径；
  // - 模型预检复用 resolveRoleModelRoute（fallback × provider 名额），并在提交前把实际
  //   选中的路由传给 submitFanoutTask；
  // - 模板只保存派发参数，不保存模型凭据/密钥/临时绝对路径；
  // - 模板 id 由 Host 生成（tpl-<uuid>），绝不把用户输入当 storage key 或路径。
  // ═══════════════════════════════════════════════════════════════════════
  const templatePlanner = createFanoutTemplatePlanner({
    roles: { isActiveRole: state.isActiveRole },
    // expertCore 是 apply 后段才装配的晚绑定值：只交出调用期解析的窄命令。
    core: { normalizeOutputSchemaDeclaration: (...args) => state.expertCore.normalizeOutputSchemaDeclaration(...args) },
    submission: { validateSubmitInput },
  });
  state.templatePlanner = templatePlanner;
  Object.assign(state, templatePlanner);

  const templateStore = createFanoutTemplateStore({
    storage: {
      activeBinding: () => host.storage.active(),
      tableEntries,
      isCurrent: (binding) => state.storageBinding.isCurrent(binding),
      domainSnapshot: () => state.storageBinding.domainSnapshot(),
      setDomainSnapshot: (next) => state.storageBinding.setDomainSnapshot(next),
    },
    persistence: {
      enqueueWrite: state.enqueueWrite,
      persistDomainEntry,
      normalizeTemplateDocumentEntries,
      storeKey: FANOUT_TEMPLATE_STORE_KEY,
    },
  });
  state.templateStore = templateStore;
  Object.assign(state, templateStore);

  const fanoutRpcReads = createFanoutRpcReads({
    identity: { agents, lineage: host.lineage },
    storage: {
      readSnapshot: state.readSnapshot,
      activeBinding: () => host.storage.active(),
      tableEntries,
      setFanoutSnapshot: (current) => state.storageBinding.setFanoutSnapshot(current),
      fanoutSnapshot: () => state.storageBinding.fanoutSnapshot(),
    },
    fanout: { getFanoutHost: () => state.fanoutHost },
    validation: { ValidationError: state.ValidationError },
  });
  state.fanoutRpcReads = fanoutRpcReads;
  Object.assign(state, fanoutRpcReads);

  const manualDispatch = createManualFanoutDispatch({
    failures: templatePlanner,
    routing: { resolveRoleModelRoute: state.resolveRoleModelRoute },
    // fanoutCommands 在装配前段创建；只交出调用期解析的窄命令。
    commands: {
      submitFanoutTask: (...args) => state.fanoutCommands.submitFanoutTask(...args),
      buildFanoutContinuationHandle: (...args) => state.fanoutCommands.buildFanoutContinuationHandle(...args),
    },
    core: { spawnProviderReady: () => state.expertCore.spawnProviderReady() },
    abort: { createAbortError: state.createAbortError },
    identity: { agents, lineage: host.lineage, isLiveRootAgent: state.isLiveRootAgent },
    reads: fanoutRpcReads,
  });
  state.manualDispatch = manualDispatch;
  Object.assign(state, manualDispatch);
  return registrations;
}
