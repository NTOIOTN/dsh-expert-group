/**
 * RPC action 分发核心（R4f · 票据 20）——共享响应适配器、传输无关分发器与「无会话域」action。
 *
 * 拆分口径（见 docs/tickets/module-decomposition/20-index-R4f-RPC-action-分发拆分.md 的映射表）：
 * 本模块持有 23 个 action 的 handler（image / meta / snapshot / fan-out / settings / notification），
 * 以及分发器的全部共用件：
 * ① 共享响应适配器 createRpcActionResponder（成功 send / 失败 fail 的统一 envelope 构造与
 *    错误类别记录）——全仓唯一一份，会话域模块只通过 per-request 的 { send, fail } 窄面消费；
 * ② mapRpcError（结构化错误 → (status, code, message, details) 的唯一映射），legacy HTTP
 *    adapter 与 Connection 通道共用同一次映射，不允许第二个副本；
 * ③ dispatchRpcAction（取消/请求体/尺寸闸门 + 动作分发表 + 未知动作 + 错误收敛）。
 *
 * 依赖形状：deps 按协作方分 8 组（services / reads / image / fanout / manualDispatch /
 * notifications / runtime / diagnostics），handler 只解构自己那几组；不接收 ctx。
 * 注册点、register 顺序与 disposer 顺序一律仍留在 index.js（票据 20 铁律 1/2）。
 */
import { MAX_RECLAIM_BATCH } from "../fanout.js";
import { restoreFailureRetryable } from "./expert-group-runtime.js";
import { abortErrorFor, createAbortError, throwIfAborted } from "./rpc-request-lifecycle.js";
import { projectInheritContextDiagnostics, projectLimitDiagnostics, projectModelPriceDiagnostics } from "./settings-read-projection.js";
import { decideImageRoute, imageCapability } from "../image-routing.js";
import { roleDescriptionsOf } from "../shared/protocol.js";
import { utf8ByteLength } from "../shared/structured.js";
import { FANOUT_TEMPLATE_LIMIT, FANOUT_TEMPLATE_VERSION } from "../storage.js";
import { randomUUID } from "node:crypto";
import { BadJsonError, PayloadTooLargeError } from "./index-rpc-http.js";
import { IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE } from "./image-transcode.js";
import { SETTINGS_NAMESPACE } from "./settings-schema.js";

/**
 * 无会话域 action → handler 的**显式**分发表（即票据 20 的 action → 模块映射表）：
 * 每个 action 名字都写死在这里，禁止按行数或前缀匹配兜底；顺序与迁移前源码顺序一致。
 * 分发表同时是唯一的路由事实源：找不到即落到会话域或「未知 action」。
 */
const GLOBAL_ROUTES = new Map([
  ["image-route", handleImageRoute],
  ["image-route-validate", handleImageRouteValidate],
  ["image-route-observer-commit", handleImageRouteObserverCommit],
  ["image-route-observer-release", handleImageRouteObserverRelease],
  ["image-route-observer-cancel", handleImageRouteObserverCancel],
  ["meta", handleMeta],
  ["expert-group-snapshot", handleExpertGroupSnapshot],
  ["fanout-dispatch", handleFanoutDispatch],
  ["fanout-template-list", handleFanoutTemplateList],
  ["fanout-template-save", handleFanoutTemplateSave],
  ["fanout-template-delete", handleFanoutTemplateSave],
  ["fanout-template-dispatch", handleFanoutTemplateDispatch],
  ["fanout-restore-retry", handleFanoutRestoreRetry],
  ["fanout-reclaim", handleFanoutReclaim],
  ["fanout-list", handleFanoutTaskActions],
  ["fanout-get", handleFanoutTaskActions],
  ["fanout-events", handleFanoutTaskActions],
  ["fanout-cancel-shard", handleFanoutTaskActions],
  ["fanout-cancel-parent", handleFanoutTaskActions],
  ["fanout-retry-shard", handleFanoutTaskActions],
  ["fanout-retry", handleFanoutTaskActions],
  ["settings-commit", handleSettingsCommit],
  ["notification-test", handleNotificationTest],
]);

/**
 * 组合根装配面：只交出两个窄命令（分发与错误映射），不交出 deps、不交出 deps.session。
 */
export function createIndexRpcActionCore(deps) {
  return {
    dispatch: (body, signal, respond, options) => dispatchRpcAction(deps, body, signal, respond, options),
    mapRpcError: (error, signal) => mapRpcError(deps, error, signal),
  };
}

/**
 * 共享响应适配器（全仓唯一一份）。
 *
 * 成功回执与失败信封的形状必须逐字段稳定：失败只有 { ok:false, error:{ code, message[, details] } }，
 * details 仅在确有结构化附加信息（当前只有 settings/会话覆盖冲突的权威 revision）时携带。
 * 两类失败都要在这里记录一次结构化错误类别（不含错误消息），因此它也是唯一的诊断收口点。
 */
export function createRpcActionResponder({ respond, errorTracker }) {
  const send = (status, value) => respond(status, value);
  const fail = (status, code, message, details) => {
    // 业务/校验失败的收口点；与 sendError 一样只记录结构化类别。
    errorTracker.note(code);
    send(status, {
      ok: false,
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    });
  };
  return { send, fail };
}

/**
 * 传输无关的业务 dispatch（迁移前 index.js:1937–3429 的 `dispatchRpcAction`）：
 * 只接收已解码的 JSON body、取消信号与一个响应收集器。legacy HTTP 与 DSH Connection 都调用它，
 * 因此认证之外的结果、结构化错误 code、ownership 判定与大小限制天然一致；
 * method/origin/content-type/读 body 仍留在 HTTP adapter（index.js 的 handleRpc）。
 *
 * 与迁移前的执行顺序逐项一致：取消 → 请求体形状 → 字节上限 → 无会话域分发表 →
 * 会话上下文前置（sessionId 必填）→ 会话域分发表 → 未知 action；任何异常都收敛到 mapRpcError。
 */
async function dispatchRpcAction(deps, body, signal, respond, { imageRequest = false } = {}) {
  const { revokeRouteClaim } = deps.image;
  const { host } = deps.runtime;
  const { session: sessionActions } = deps;
  const { send, fail } = createRpcActionResponder({ respond, errorTracker: deps.runtime.rpcErrorTracker });
  try {
    // 取消在业务动作之前就收敛，避免客户端已断开时仍进入 settings/storage 写路径。
    // 对 claim 相关动作额外释放 Host 暂存的路由声明（含 observer 的 durable refs）：
    // 已取消的提交不会再有合法消费者，留下 pending claim 只会占用有界表直到 TTL。
    if (signal?.aborted === true) {
      if ((body?.action === "image-route-validate" || body?.action === "image-route-observer-commit")
        && typeof body?.routeClaim === "string") {
        revokeRouteClaim(body.routeClaim);
      }
      throw createAbortError();
    }
    if (typeof body !== "object" || body === null) { fail(400, "bad-request", "请求体必须是 JSON 对象"); return; }
    // 两条传输共用同一字节上限：HTTP 在读 body 时快速拒绝，Connection 直接投递
    // 已解码 payload，这里补上同一限制，避免绕过普通 / settings-commit / 图片三档边界。
    // 预算选择复用 host/rpc.transport 的同一函数，两条传输不会各自硬编码数字。
    if (Buffer.byteLength(JSON.stringify(body)) > host.rpc.limitFor({ imageRequest, action: body.action })) {
      fail(413, "payload-too-large", "请求体超过允许上限");
      return;
    }
    const globalRun = GLOBAL_ROUTES.get(body.action);
    if (globalRun !== void 0) { await globalRun(deps, { body, signal, send, fail, imageRequest }); return; }
    // 非无会话域 action：先解析会话上下文（与迁移前 sessionId/isChild 前置的**位置**语义一致）——
    // 因此「未知 action 且缺 sessionId」仍返回「缺少 sessionId」，不会退化成「未知 action」。
    const sessionContext = sessionActions.resolveSession(body, fail);
    if (sessionContext === void 0) return;
    const sessionRun = sessionActions.routes.get(body.action);
    if (sessionRun !== void 0) { await sessionRun({ ...sessionContext, body, signal, send, fail }); return; }
    fail(400, "bad-request", "未知 action");
  } catch (error) {
    const mapped = mapRpcError(deps, error, signal);
    fail(mapped.status, mapped.code, mapped.message, mapped.details);
  }
}

/**
 * 手动派发与四个模板动作共用的 root 授权边界（原始源行归属 2357–2363）：
 * 只允许 root-only / exact live root；失败按 requireManualFanoutRoot 给出的
 * (status, code, message, details) 原样回执（逐字段与迁移前一致）。
 * 返回 root Agent；授权失败时响应已写出，调用方直接 return。
 */
function requireFanoutRoot(deps, body, fail) {
  const rootState = deps.manualDispatch.requireManualFanoutRoot(body);
  if (rootState.ok !== true) {
    const failure = rootState.failure;
    fail(failure.status, failure.code, failure.message, failure.details);
    return void 0;
  }
  return rootState.parent;
}

/**
 * 共享错误契约：两条传输都通过它把同一批结构化错误映射为 (status, code, message)。
 * 结构化错误类别的诊断记录发生在实际写响应的收口点（fail / sendError / channel 早停），
 * 因此同一请求只会被记录一次，且记录内容里不含错误消息。
 */
export function mapRpcError(deps, error, signal) {
  const { ValidationError, host, logger } = deps.runtime;
  const { settings } = deps.services;
  // DSH Gateway 使用 gateway/cancelled 表示远端主动取消；保留同一身份，
  // 避免 Connection/客户端把取消误判为可重试的 500 internal。
  if (signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return { status: 499, code: "gateway/cancelled", message: "请求已取消" };
  }
  if (error instanceof PayloadTooLargeError || host.rpc.isBodyTooLarge(error)) {
    return { status: 413, code: "payload-too-large", message: "请求体超过允许上限" };
  }
  if (error instanceof BadJsonError) {
    return { status: 400, code: "bad-request", message: error.message };
  }
  if (error?.code === "MODEL_DIRECTORY_CHANGED") {
    // 写入边界发现目录已变化：让客户端保留 dirty 草稿并重新校验。
    return { status: 400, code: "invalid-selection", message: error.message };
  }
  if (error?.message === IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE
    || error?.message === "图片无法真实转换为 PNG") {
    return { status: 503, code: "image-transcoder-unavailable", message: error.message };
  }
  if (error?.code === "session-not-found") {
    return { status: 404, code: "session-not-found", message: "根会话不存在或尚未恢复" };
  }
  if (error?.code === "route-changed") {
    // 模型在图片提交期间被切换：这是可重试的状态冲突（409），不是客户端输入错误，
    // 也不是 500 内部错误；客户端据此 abandon 本次提交且不调用 session.prompt。
    return { status: 409, code: "route-changed", message: error.message };
  }
  if (error?.code === "route-commit-in-progress") {
    // 同一 Observer claim 的重复/并发 commit：一次性语义，保持 409 状态冲突。
    return { status: 409, code: "route-commit-in-progress", message: error.message };
  }
  if (error?.code === "route-claim-invalid") {
    // 任意/过期/跨会话/跨代际的 claim：显式 400，绝不把它当作校验成功。
    return { status: 400, code: "route-claim-invalid", message: error.message };
  }
  if (error?.code === "route-cleanup-invalid") {
    // 清理凭据无效/已消费/跨会话/跨代际：404（资源已不存在语义），
    // 且不区分是哪一项校验失败。客户端只做尽力清理，保留原始 prompt 错误。
    return { status: 404, code: "route-cleanup-invalid", message: error.message };
  }
  if (error?.code === "observer-cleanup-capacity") {
    // cleanup token 容量已满：拒绝启动新的 Observer child（503 服务暂不可用语义），
    // 而不是淘汰仍可能活跃的旧 token 把旧 child 变成孤儿。
    return { status: 503, code: "observer-cleanup-capacity", message: error.message };
  }
  if (error?.name === "FanoutValidationError") {
    return { status: 400, code: typeof error.code === "string" ? error.code : "invalid-fanout", message: error.message };
  }
  if (error instanceof ValidationError) {
    // 角色/模型目录校验失败是客户端输入问题，返回 400 而非 500。
    return { status: 400, code: "invalid-selection", message: error.message };
  }
  if (error?.validation === true) {
    // 结构化客户端输入错误（如图片声明的 mediaType 与真实字节不符）：
    // 必须返回 400，而不是把客户端问题伪装成 500 internal。
    return { status: 400, code: "invalid-selection", message: error.message };
  }
  if (error?.code === "SESSION_OVERRIDE_CONFLICT") {
    // 会话覆盖的 CAS 冲突（票据 21）：与 settings 冲突同一语义（409 + 权威代次），
    // 客户端据此保留草稿、推进本地代次并提示重试。details 只含固定形状的
    // currentRevision 与归一后的覆盖映射，不含会话正文或任何请求体。
    const currentRevision = Number.isSafeInteger(error.currentRevision) && error.currentRevision >= 0
      ? error.currentRevision
      : 0;
    const overrides = error.overrides !== null && typeof error.overrides === "object"
      && !Array.isArray(error.overrides)
      ? error.overrides
      : {};
    return {
      status: 409,
      code: "session-override-conflict",
      message: error.message,
      details: { currentRevision, overrides },
    };
  }
  if (error?.code === "SETTINGS_CONFLICT") {
    // 冲突必须携带 Host 的权威 revision：客户端据此只推进本地 revision 并保留 dirty
    // 草稿。revision 优先取错误的显式字段（adapter 可提供），否则实时读取当前描述符；
    // 两条传输（legacy HTTP 与 Connection）共用本函数，因此形状天然一致。
    let revision = Number.isSafeInteger(error?.currentRevision) && error.currentRevision >= 0 ? error.currentRevision : void 0;
    if (revision === void 0) {
      // 部分宿主/替身没有 settings.describe；此时只知道"冲突"，不能伪造 revision。
      try { revision = settings.describe?.().find((entry) => entry.ns === SETTINGS_NAMESPACE)?.revision; } catch { revision = void 0; }
    }
    return {
      status: 409,
      code: "settings-conflict",
      message: error.message,
      ...(Number.isSafeInteger(revision) && revision >= 0 ? { details: { revision } } : {}),
    };
  }
  // 原始内部错误只记日志，不向客户端回传（可能含路径/密钥等敏感信息）。
  logger.warn("dsh-expert-group rpc failed: " + (error instanceof Error ? error.message : String(error)));
  return { status: 500, code: "internal", message: "内部错误，请查看服务端日志" };
}

/**
 * 「image-route」 的 handler（原始源行归属 1974–2077）。
 */
async function handleImageRoute(deps, req) {
  const {
    imageRouteDiagnostics, issueRouteClaim, normalizeUploadedImages, resolveMainImageRoute,
    resolveRole, responseDelivered, revokeRouteClaim, routeClaimError, validateImageRouteBody,
    verifyRouteClaim
  } = deps.image;
  const { source } = deps.reads;
  const { ValidationError, host } = deps.runtime;
  const { agents, config, llm, roleTools } = deps.services;
  const { body, signal, send, fail, imageRequest } = req;

  if (body.action === "image-route") {
    if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
    validateImageRouteBody(body);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    const parent = agents.get(sessionId);
    if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    // 先把全部上传项验证并落成 Host-owned PNG durable refs，再读取模型能力；
    // 无论最终走主模型、Observer 还是能力拒绝，识别边界都不会接触原始格式。
    // const normalized = await normalizeUploadedImages(body.images);
    // const normalized = await normalizeUploadedImages(body.images);
    const normalized = await normalizeUploadedImages(body.images, signal);
    throwIfAborted(signal);
    const snapshot = source();
    const mainRoute = resolveMainImageRoute(parent);
    let mainImage = "unknown";
    if (mainRoute.provider !== undefined && mainRoute.model !== undefined) {
      try {
        mainImage = imageCapability(await llm.resolveModelInfo(mainRoute.provider, mainRoute.model, signal));
      } catch (error) {
        // 取消必须原样上抛；只有真正的非取消失败才保持 unknown（main-first）。
        const aborted = abortErrorFor(error, signal);
        if (aborted !== void 0) throw aborted;
      }
    }
    throwIfAborted(signal);
    let observerImage = "unknown";
    let observerSelection;
    const shouldProbeObserver = snapshot.observerPreferred === true || mainImage === "unsupported";
    if (shouldProbeObserver && config.enableObserver === true && roleTools.routeImageToObserver() !== void 0) {
      observerSelection = resolveRole(sessionId, "observer");
      if (observerSelection !== null) {
        try {
          observerImage = imageCapability(await llm.resolveModelInfo(observerSelection.provider, observerSelection.model, signal));
        } catch (error) {
          const aborted = abortErrorFor(error, signal);
          if (aborted !== void 0) throw aborted;
          observerImage = "unknown";
        }
      }
    }
    throwIfAborted(signal);
    const decision = decideImageRoute({
      mainImage,
      observerImage,
      observerPreferred: snapshot.observerPreferred === true,
    });
    if (decision.target === "error") throw new ValidationError(decision.message);
    const capability = imageRouteDiagnostics({ mainImage, observerImage, mainRoute });
    // TOCTOU 保护（签发）：把"能力判定所依据的路由"固化成不透明 claim 回传客户端。
    // 客户端在真正 session.prompt 之前必须用它做一次校验，避免能力判定模型与实际
    // prompt 模型不一致（插件不改 DSH 核心，也不存在原子 generation API）。
    //
    // Observer 走**两阶段**：这一步只签发 claim 并暂存 Host 创建的 durable PNG refs，
    // **不**启动 Observer。否则一旦 claim 校验失败/模型切换/请求取消，客户端不 prompt
    // 而 child 已创建，就会留下向 root 反馈的孤儿 child。真正的 admission 只发生在
    // image-route-observer-commit。
    const observerRefs = decision.target === "observer"
      ? normalized.map(({ attachment }) => attachment)
      : void 0;
    const claim = issueRouteClaim({
      sessionId,
      route: mainRoute,
      target: decision.target === "observer" ? "observer" : "main",
      // exact root generation：同 id 的 root 被重建/替换后，这个 claim 必须失效，
      // 否则旧代际的图片提交会落到新 root 上。
      rootToken: host.lineage.tokenFor(parent),
      observerAttachments: observerRefs,
      capability,
    });
    // 签发之后只有"成功把 claim 交给客户端"才允许保留它；任何自检失败、取消、
    // 结构化错误或响应发送异常都必须回收，避免留下 pending claim（含暂存 refs）。
    // main 成功返回时同样保留 claim（它的生命周期由 image-route-validate 消费）。
    let claimHandedOff = false;
    try {
      // TOCTOU 保护（Host 自检）：能力查询是异步的，期间模型可能再次切换。这里在
      // 返回成功之前重新读取当前路由并与 claim 摘要核对，避免明显窗口。
      const recheck = verifyRouteClaim({ claim: claim.id, sessionId, consume: "never" });
      throwIfAborted(signal);
      if (recheck.ok !== true) throw routeClaimError(recheck.reason);
      if (decision.target === "main") {
        const delivery = send(200, {
          ok: true,
          target: "main",
          images: normalized.map(({ data, mediaType, name }) => ({ data, mediaType, name })),
          capability,
          routeClaim: claim.id,
        });
        // 只有响应真的写出去了才算交付；写入被传输层吸收（socket 竞态）时立即回收 claim。
        claimHandedOff = responseDelivered(delivery);
        return;
      }
      // Observer 分支只回传 claim 与三态能力：没有 childId，也就没有孤儿 child。
      // 这里刻意不回传用户 text —— 自动入口的 Observer admission 不含任何用户原文。
      const observerDelivery = send(200, { ok: true, target: "observer", capability, routeClaim: claim.id });
      claimHandedOff = responseDelivered(observerDelivery);
      return;
    } finally {
      if (claimHandedOff !== true) revokeRouteClaim(claim.id);
    }
  }
}

/**
 * 「image-route-validate」 的 handler（原始源行归属 2078–2111）。
 */
async function handleImageRouteValidate(deps, req) {
  const {
    responseDelivered, revokeRouteClaim, routeClaimError, validateImageRouteValidateBody,
    verifyRouteClaim
  } = deps.image;
  const { agents } = deps.services;
  const { body, signal, send, fail, imageRequest } = req;

  if (body.action === "image-route-validate") {
    // 客户端在真正 session.prompt 之前的 TOCTOU 复核：Host 重新读取当前 effective
    // model route，并与签发时的摘要比较。claim 必须是本插件签发、绑定同一 root
    // session 的不透明 id；任意字符串、跨会话回放、过期或路由已变化都显式失败。
    //
    // 消费语义：main 的 claim 校验成功即消费；Observer 的 claim **只验证不消费**，
    // 因为它还要交给 image-route-observer-commit 一次性消费（防止重复 commit）。
    if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
    validateImageRouteValidateBody(body);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    const parent = agents.get(sessionId);
    if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    throwIfAborted(signal);
    const verified = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "main-only" });
    throwIfAborted(signal);
    if (verified.ok !== true) {
      // 路由已变化的 claim 不再可用：显式删除，避免留下悬挂的 observer refs。
      revokeRouteClaim(body.routeClaim);
      throw routeClaimError(verified.reason);
    }
    const validateDelivery = send(200, { ok: true, target: verified.target === "observer" ? "observer" : "main" });
    if (responseDelivered(validateDelivery) !== true) {
      // 响应没有真正交付：客户端拿不到复核结果，也就不会进入 commit。
      // observer 的 claim 仍被"只验证不消费"地保留着，这里必须显式删除（连同暂存的
      // durable refs），否则它既无法被消费又占容量。main 的 claim 已在成功校验时消费，
      // 重复删除是无副作用的 no-op。
      revokeRouteClaim(body.routeClaim);
    }
    return;
  }
}

/**
 * 「image-route-observer-commit」 的 handler（原始源行归属 2112–2209）。
 */
async function handleImageRouteObserverCommit(deps, req) {
  const {
    interruptObserverChild, issueObserverCleanupToken, markRouteClaimCommitting,
    releaseObserverCleanupSlot, reserveObserverCleanupSlot, responseDelivered,
    revokeObserverCleanupToken, revokeRouteClaim, routeClaimError, validateImageRouteCommitBody,
    verifyRouteClaim
  } = deps.image;
  const { ValidationError } = deps.runtime;
  const { agents, roleTools } = deps.services;
  const { body, signal, send, fail, imageRequest } = req;

  if (body.action === "image-route-observer-commit") {
    // Observer 两阶段的第二阶段：claim 当前路由复核 → Observer admission → 消费 claim。
    // commit 失败绝不启动 child；admission 已接受但后续检测失败（取消/路由变化）时，
    // 用公开 subagents.interrupt 尽力清理，避免孤儿 child 向 root 反馈。
    if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
    validateImageRouteCommitBody(body);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    const parent = agents.get(sessionId);
    if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    throwIfAborted(signal);
    const peeked = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "never" });
    if (peeked.ok !== true) {
      // 路由已变化/claim 失效：显式清理，连暂存的 durable refs 一起丢弃。
      revokeRouteClaim(body.routeClaim);
      throw routeClaimError(peeked.reason);
    }
    if (peeked.target !== "observer" || peeked.entry === void 0) {
      // 目标不匹配（例如 main 的 claim 被误发到 commit）：拒绝这次 commit，但不改动
      // 那个 claim 的生命周期 —— 它的合法消费动作是 image-route-validate。
      throw routeClaimError("unknown-claim");
    }
    const entry = peeked.entry;
    if (entry.state !== "issued") {
      // 一次性语义：同一 claim 不允许并发/重复 commit。
      throw routeClaimError("route-commit-in-progress");
    }
    if (roleTools.routeImageToObserver() === void 0) {
      revokeRouteClaim(body.routeClaim);
      throw new ValidationError("Observer 专家当前未启用或尚未挂载，无法提交图片；原始输入已保留");
    }
    markRouteClaimCommitting(body.routeClaim);
    // 容量预占：必须在启动 Observer **之前**完成。表满时宁可拒绝本次 commit
    // （结构化 503），也绝不为新 child 淘汰仍可能活跃的旧 token —— 否则旧 child
    // 会失去客户端补偿通道并退化成孤儿。
    if (reserveObserverCleanupSlot() !== true) {
      revokeRouteClaim(body.routeClaim);
      const error = new Error("Observer 图片清理凭据已满，暂时无法启动新的图片分析；请稍后重试");
      error.code = "observer-cleanup-capacity";
      throw error;
    }
    let reservationHeld = true;
    let issuedCleanupToken;
    let childId;
    try {
      throwIfAborted(signal);
      const observerResult = await roleTools.routeImageToObserver()({
        parent,
        preparedAttachments: Array.isArray(entry.observerAttachments) ? entry.observerAttachments : [],
        signal: signal,
        // admission 的 childId 必须在 routeImageToObserver 内部的后置检查之前回传，
        // 否则"已接受但随后取消"的路径拿不到 childId，就无法尽力中断孤儿 child。
        onAccepted: (acceptedChildId) => { childId = acceptedChildId; },
      });
      if (typeof observerResult?.childId === "string") childId = observerResult.childId;
      // admission 之后：取消或路由再次变化都必须清理刚创建的 child。
      const post = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "never" });
      throwIfAborted(signal);
      if (post.ok !== true) throw routeClaimError(post.reason);
      revokeRouteClaim(body.routeClaim);
      // 关键窗口：commit 已经把 childId 交给客户端，但客户端接下来的 session.prompt
      // 仍可能失败/取消。把预占转成一次性、进程内、有界的 cleanup token，绑定
      // {sessionId, exact root generation, childId}，客户端据此可请求 Host 中断该 child。
      issuedCleanupToken = typeof childId === "string" && childId.length > 0
        ? issueObserverCleanupToken({ sessionId, rootToken: entry.rootToken, childId })
        : void 0;
      // 预占已转成 token（净占用不变），失败路径不再重复释放。
      reservationHeld = false;
      const delivery = send(200, {
        ok: true,
        target: "observer",
        childId: typeof childId === "string" ? childId : void 0,
        ...(issuedCleanupToken === void 0 ? {} : { cleanupToken: issuedCleanupToken }),
        capability: entry.capability,
      });
      if (responseDelivered(delivery) !== true) {
        // 响应没有真正交付（socket 竞态被传输层吸收）：客户端永远拿不到 childId/
        // cleanupToken，因此必须立即撤销凭据并尽力中断 child，绝不能把这种竞态
        // 当成成功交付，留下一个无凭据的 Observer child。
        revokeObserverCleanupToken(issuedCleanupToken);
        issuedCleanupToken = void 0;
        await interruptObserverChild(childId, parent);
        return;
      }
      return;
    } catch (error) {
      // 失败路径同样删除 claim（连同暂存的 durable refs）：撤销未交付的 token、
      // 释放未消费的预占，并尽力中断已创建的 child。
      revokeRouteClaim(body.routeClaim);
      revokeObserverCleanupToken(issuedCleanupToken);
      if (reservationHeld) releaseObserverCleanupSlot();
      await interruptObserverChild(childId, parent);
      throw error;
    }
  }
}

/**
 * 「image-route-observer-release」 的 handler（原始源行归属 2210–2231）。
 */
async function handleImageRouteObserverRelease(deps, req) {
  const { consumeObserverCleanupToken, validateImageRouteReleaseBody } = deps.image;
  const { body, send, fail, imageRequest } = req;

  if (body.action === "image-route-observer-release") {
    // 成功 observed 后的凭据释放：Observer child 已由 DSH 正常收口，客户端不再需要
    // 清理凭据。校验同 cancel（session + exact root generation + childId）后消费 token，
    // 但**绝不调用 interrupt** —— release 误中断会把已交付的视觉分析打掉。
    // 消费后容量立即释放，连续成功提交不会再累积到上限。
    if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
    validateImageRouteReleaseBody(body);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    const released = consumeObserverCleanupToken({
      token: body.cleanupToken,
      sessionId,
      childId: body.childId,
    });
    if (released.ok !== true) {
      const error = new Error("图片提交清理凭据无效或已过期");
      error.code = "route-cleanup-invalid";
      throw error;
    }
    send(200, { ok: true });
    return;
  }
}

/**
 * 「image-route-observer-cancel」 的 handler（原始源行归属 2232–2261）。
 */
async function handleImageRouteObserverCancel(deps, req) {
  const { consumeObserverCleanupToken, validateImageRouteCancelBody } = deps.image;
  const { subagents } = deps.services;
  const { body, send, fail, imageRequest } = req;

  if (body.action === "image-route-observer-cancel") {
    // Observer commit 成功后客户端提交 root prompt 失败/取消时的补偿动作：
    // 校验一次性 cleanup token（session + child + exact root generation）后中断 child。
    // 这不是新的 DSH API，只是对现有公开 subagents.interrupt 的受控封装：
    // token 一旦校验通过就消费（无论 interrupt 成功与否），对外失败统一 404，
    // 不泄露究竟是哪一项校验失败。
    if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
    validateImageRouteCancelBody(body);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    const consumed = consumeObserverCleanupToken({
      token: body.cleanupToken,
      sessionId,
      childId: body.childId,
    });
    if (consumed.ok !== true) {
      const error = new Error("图片提交清理凭据无效或已过期");
      error.code = "route-cleanup-invalid";
      throw error;
    }
    try {
      if (typeof subagents?.interrupt === "function") {
        await subagents.interrupt(consumed.childId, { kind: "ancestor", agent: consumed.parent });
      }
    } catch {
      // interrupt 失败不影响 token 已消费的一次性语义；也不向客户端泄露内部原因。
    }
    send(200, { ok: true });
    return;
  }
}

/**
 * 「meta」 的 handler（原始源行归属 2262–2334）。
 */
async function handleMeta(deps, req) {
  const { describeHostCapabilities, describeRuntimeDiagnostics } = deps.diagnostics;
  const {
    activeRoles, describeRolePrompts, fanoutHost, roleCatalog, roleLabelsProjection, source,
    usageSummaryFor
  } = deps.reads;
  const { config } = deps.services;
  const { body, send } = req;

  if (body.action === "meta") {
    // 设置页不绑定具体会话：角色状态必须来自 Host 配置，避免 child/no-session 误判 Observer。
    const roles = activeRoles();
    const snap = source();
    // budget 是只读投影（用量 / 冻结上限 / 最近一次违规）：客户端与诊断据此判断
    // 是否接近数据资源预算；不携带任何任务负载，也不写入 settings/domain。
    // 先用 typeof 判定标识符本身：'service?.x' 仍会对未声明标识符抛 ReferenceError，
    // 而旧测试替身可能没有 fanoutHost。typeof 对未声明标识符是安全的。
    const budget = typeof fanoutHost !== "undefined" && typeof fanoutHost.budget === "function"
      ? fanoutHost.budget()
      : void 0;
    send(200, {
      ok: true,
      roles,
      activeRoles: roles,
      // 角色只读投影：客户端据此渲染设置页角色表与侧栏标签；
      // roleLabels 是显示名（英文，与角色状态标签一致），roleDescriptions 是职责摘要（设置页提示）。
      roleLabels: roleLabelsProjection(),
      // 「会话模型」的全局默认读面：与 resolveRole 同源（snap.defaults），侧边栏据此显示
      // 「跟随全局默认」。这里只是只读投影，不改 get/session-override-* 的任何行为。
      roleDefaults: snap.defaults ?? {},
      roleDescriptions: roleDescriptionsOf(roleCatalog().records()),
      enableObserver: config.enableObserver === true,
      observerPreferred: snap.observerPreferred === true,
      roleConcurrencyLimit: snap.roleConcurrencyLimit,
      /**
       * 并发映射（票据 26）：meta 必须携带这两个字段，否则设置页无法渲染
       * 逐角色/provider 编辑面（客户端波次），诊断也无法解释任务为什么排队。
       * 只回传归一后的生效值 + 有界的丢弃诊断，不回传 settings 原始文档。
       */
      roleLimits: snap.roleLimits ?? {},
      providerLimits: snap.providerLimits ?? {},
      limitDiagnostics: projectLimitDiagnostics(snap.limitDiagnostics),
      /**
       * 角色级上下文继承（票据 29）：只含内置非 Observer 角色的显式 true。
       * 设置页继承开关与 token 成本提示属客户端波次；服务端只提供读取面与
       * 保存面。是否真正可用仍取决于宿主是否有合格的 fork provider（派发时
       * fail-closed 校验，错误码 CONTEXT_INHERITANCE_UNAVAILABLE）。
       */
      inheritContext: snap.inheritContext ?? {},
      inheritContextDiagnostics: projectInheritContextDiagnostics(snap.inheritContextDiagnostics),
      /**
       * 单价（票据 25）：meta 只回传**原始单价**（每百万 token）与读取期诊断，
       * 不在后端计算/展示成本——缺单价时客户端显示 token 与请求数即可，
       * 绝不显示假成本。cost 估算由客户端按需调用同一套纯函数规则。
       */
      modelPrices: Array.isArray(snap.modelPrices) ? snap.modelPrices : [],
      modelPriceDiagnostics: projectModelPriceDiagnostics(snap.modelPriceDiagnostics),
      /**
       * 用量聚合（票据 25，全局只读）：totals / byRole / byProvider / byModel /
       * recentTasks（≤16）。只由 child_models.usage 与 live 账本投影，不含
       * prompt/response/凭据/完整路径；没有样本时 totals 为 null，不补 0。
       */
      usage: usageSummaryFor(null),
      // 角色默认超时（毫秒，0=不启用）：meta 只回传归一后的生效值。
      roleTimeoutMs: snap.roleTimeoutMs,
      // 任务管理默认开启：meta 只回传归一后的生效值，供设置页与诊断读取。
      taskManagementEnabled: snap.taskManagementEnabled !== false,
      // 自动打开默认关闭：meta 只回传归一后的生效布尔值。
      autoOpenSubagentSidebar: snap.autoOpenSubagentSidebar === true,
      // 左侧栏入口默认开启（与任务管理同款宽松语义）：只有显式 false 才为 false。
      sidebarEntryEnabled: snap.sidebarEntryEnabled !== false,
      // 只读提示词自定义投影：六个角色（含未启用的 observer）、各自当前生效的
      // 专家专属 persona 与 grapheme 上限。设置页据此渲染编辑器与"恢复默认"，
      // 不需要也不允许自己猜测 Host 状态。这里不含固定执行纪律副本。
      rolePrompts: describeRolePrompts(snap),
      ...(budget === void 0 ? {} : { budget }),
      // 只读能力矩阵与运行时诊断：只有固定状态枚举、计数与结构化错误类别，
      // 不含 prompt、原始请求体、token、Cookie、authorization、会话/agent id
      // 或任何完整路径；两者都由本文件内的投影函数构造，结构固定且有界。
      capabilities: describeHostCapabilities(),
      diagnostics: describeRuntimeDiagnostics(),
    });
    return;
  }
}

/**
 * 「expert-group-snapshot」 的 handler（原始源行归属 2335–2340）。
 */
async function handleExpertGroupSnapshot(deps, req) {
  const { expertGroupRuntime } = deps.reads;
  const { body, send, fail } = req;

  if (body.action === "expert-group-snapshot") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    send(200, { ok: true, snapshot: await expertGroupRuntime.snapshotForSession(sessionId) });
    return;
  }
}

/**
 * 「fanout-dispatch」 的 handler（原始源行归属 2365–2372）。
 */
async function handleFanoutDispatch(deps, req) {
  const { buildManualDispatchPlan, runManualFanoutDispatch } = deps.manualDispatch;
  const { body, signal, send, fail } = req;
  const parent = requireFanoutRoot(deps, body, fail);
  if (parent === void 0) return;

  if (body.action === "fanout-dispatch") {
    const plan = buildManualDispatchPlan(body);
    if (plan.ok !== true) { fail(plan.status, plan.code, plan.message, plan.details); return; }
    const outcome = await runManualFanoutDispatch(parent, plan, signal);
    if (outcome.ok !== true) { fail(outcome.status, outcome.code, outcome.message, outcome.details); return; }
    send(200, { ok: true, ...outcome.receipt });
    return;
  }
}

/**
 * 「fanout-template-list」 的 handler（原始源行归属 2374–2389）。
 */
async function handleFanoutTemplateList(deps, req) {
  const { readFanoutTemplateDocument, summarizeFanoutTemplate } = deps.manualDispatch;
  const { body, send, fail } = req;
  if (requireFanoutRoot(deps, body, fail) === void 0) return;

  // 以下模板动作都要求模板存储 ready：缺少 binding 时明确 503，绝不用空库冒充保存成功。
  if (body.action === "fanout-template-list") {
    const templateState = readFanoutTemplateDocument();
    if (templateState.ok !== true) {
      fail(503, "template-storage-unavailable", "模板存储尚未就绪");
      return;
    }
    const templateDocument = templateState.document;
    send(200, {
      ok: true,
      templates: templateDocument.templates.map((template) => summarizeFanoutTemplate(template)),
      count: templateDocument.templates.length,
      limit: FANOUT_TEMPLATE_LIMIT,
    });
    return;
  }
}

/**
 * 「fanout-template-save」 / 「fanout-template-delete」 的 handler（原始源行归属 2391–2492）。
 */
async function handleFanoutTemplateSave(deps, req) {
  const {
    FANOUT_TEMPLATE_MAX_BYTES, buildFanoutTemplatePlan, manualDispatchFailure,
    persistFanoutTemplateDocument, readFanoutTemplateDocument, runFanoutTemplateMutation,
    summarizeFanoutTemplate
  } = deps.manualDispatch;
  const { isActiveRole } = deps.reads;
  // 落盘失败只记结构化告警（不含模板内容），与迁移前 ctx.logger 同源。
  const { logger } = deps.runtime;
  const { body, send, fail } = req;
  const parent = requireFanoutRoot(deps, body, fail);
  if (parent === void 0) return;

  if (body.action === "fanout-template-save" || body.action === "fanout-template-delete") {
    // 保存的纯结构校验可以放在锁外；真正读文档、判重、判上限与落盘都在同一条
    // 串行链里完成，避免两个并发保存基于同一份旧文档互相覆盖（丢更新）。
    const plan = body.action === "fanout-template-save" ? buildFanoutTemplatePlan(body) : undefined;
    if (plan !== undefined && plan.ok !== true) {
      fail(plan.status, plan.code, plan.message, plan.details);
      return;
    }
    const outcome = await runFanoutTemplateMutation(async () => {
      const templateState = readFanoutTemplateDocument();
      if (templateState.ok !== true) {
        return manualDispatchFailure(503, "template-storage-unavailable", "模板存储尚未就绪");
      }
      const templateDocument = templateState.document;

      if (body.action === "fanout-template-delete") {
        const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
        if (templateId.length === 0) {
          return manualDispatchFailure(400, "bad-request", "缺少 templateId");
        }
        const index = templateDocument.templates.findIndex((template) => template?.id === templateId);
        if (index < 0) return manualDispatchFailure(404, "template-not-found", "模板不存在");
        const templates = templateDocument.templates.filter((_, entryIndex) => entryIndex !== index);
        const document = { version: FANOUT_TEMPLATE_VERSION, templates };
        try {
          await persistFanoutTemplateDocument(document);
        } catch (error) {
          logger.warn("dsh-expert-group: fan-out template persistence failed: "
            + (error instanceof Error ? error.message : String(error)));
          return manualDispatchFailure(500, "template-persist-failed", "模板删除未能落盘，模板库保持不变，可稍后重试");
        }
        return { ok: true, value: { deleted: true, templateId, count: templates.length } };
      }

      // 锁外只做了纯结构校验；真正落盘前再确认角色仍启用，避免校验与写入之间
      // 角色被删除/禁用后仍保存出一个不可派发的模板。
      if (!isActiveRole(plan.template.role)) {
        return manualDispatchFailure(400, "invalid-role", "未启用的角色: " + plan.template.role, { field: "role" });
      }
      const rawTemplateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
      const existingIndex = rawTemplateId.length === 0
        ? -1
        : templateDocument.templates.findIndex((template) => template?.id === rawTemplateId);
      if (rawTemplateId.length > 0 && existingIndex < 0) {
        return manualDispatchFailure(404, "template-not-found", "模板不存在");
      }
      if (rawTemplateId.length === 0 && templateDocument.templates.length >= FANOUT_TEMPLATE_LIMIT) {
        return manualDispatchFailure(
          400,
          "template-limit",
          "模板数量已达上限 " + FANOUT_TEMPLATE_LIMIT + " 个，请先删除不再使用的模板",
          { limit: FANOUT_TEMPLATE_LIMIT, count: templateDocument.templates.length },
        );
      }
      const now = Date.now();
      const existing = existingIndex >= 0 ? templateDocument.templates[existingIndex] : undefined;
      // 模板 id 由 Host 生成，绝不使用用户输入作为 key/路径；更新只按已有 id 匹配。
      const templateId = rawTemplateId.length > 0 ? rawTemplateId : "tpl-" + randomUUID();
      const template = {
        id: templateId,
        ...plan.template,
        createdAt: Number.isSafeInteger(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      };
      const templates = existingIndex >= 0
        ? templateDocument.templates.map((entry, index) => (index === existingIndex ? template : entry))
        : [...templateDocument.templates, template];
      const document = { version: FANOUT_TEMPLATE_VERSION, templates };
      const bytes = utf8ByteLength(JSON.stringify(document));
      if (!Number.isSafeInteger(bytes) || bytes > FANOUT_TEMPLATE_MAX_BYTES) {
        return manualDispatchFailure(
          400,
          "template-limit",
          "模板库总量超过上限 " + FANOUT_TEMPLATE_MAX_BYTES + " 字节，请删除不再使用的模板",
          {
            maxBytes: FANOUT_TEMPLATE_MAX_BYTES,
            bytes: Number.isSafeInteger(bytes) ? bytes : null,
            count: templates.length,
          },
        );
      }
      try {
        await persistFanoutTemplateDocument(document);
      } catch (error) {
        logger.warn("dsh-expert-group: fan-out template persistence failed: "
          + (error instanceof Error ? error.message : String(error)));
        // 先落盘再返回：失败时磁盘与读取投影都保持旧文档，绝不宣告半成功。
        return manualDispatchFailure(500, "template-persist-failed", "模板保存未能落盘，模板库保持不变，可稍后重试");
      }
      return {
        ok: true,
        value: {
          created: existingIndex < 0,
          template: summarizeFanoutTemplate(template),
          count: templates.length,
        },
      };
    });
    if (outcome.ok !== true) { fail(outcome.status, outcome.code, outcome.message, outcome.details); return; }
    send(200, { ok: true, ...outcome.value });
    return;
  }
}

/**
 * 「fanout-template-dispatch」 的 handler（原始源行归属 2494–2539）。
 */
async function handleFanoutTemplateDispatch(deps, req) {
  const { buildFanoutTemplatePlan, readFanoutTemplateDocument, runManualFanoutDispatch } = deps.manualDispatch;
  const { body, signal, send, fail } = req;
  const parent = requireFanoutRoot(deps, body, fail);
  if (parent === void 0) return;

  const templateState = readFanoutTemplateDocument();
  if (templateState.ok !== true) {
    fail(503, "template-storage-unavailable", "模板存储尚未就绪");
    return;
  }
  const templateDocument = templateState.document;

  // fanout-template-dispatch：模板内容是不可信输入，重新按当前角色/预算/schema 校验。
  const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  if (templateId.length === 0) {
    fail(400, "bad-request", "缺少 templateId");
    return;
  }
  const template = templateDocument.templates.find((entry) => entry?.id === templateId);
  if (template === undefined) {
    fail(404, "template-not-found", "模板不存在");
    return;
  }
  let requestId;
  if (body.requestId !== undefined && body.requestId !== null) {
    if (typeof body.requestId !== "string" || body.requestId.trim().length === 0) {
      fail(400, "INVALID_REQUEST_ID", "requestId 必须是非空字符串");
      return;
    }
    requestId = body.requestId;
  }
  const templatePlan = buildFanoutTemplatePlan({
    name: template.name,
    role: template.role,
    ...(template.prompt === undefined ? {} : { prompt: template.prompt }),
    ...(template.basePrompt === undefined ? {} : { basePrompt: template.basePrompt }),
    ...(template.shards === undefined ? {} : { shards: template.shards }),
    allowOverlap: template.allowOverlap,
    concurrencyLimit: template.concurrencyLimit,
    timeoutMs: template.timeoutMs,
  });
  if (templatePlan.ok !== true) {
    // 模板保存后角色被删除/禁用、schema 被篡改、超时越界等都收敛为同一来源的稳定 code。
    fail(templatePlan.status, templatePlan.code, templatePlan.message, templatePlan.details);
    return;
  }
  if (requestId !== undefined) templatePlan.plan.args.requestId = requestId;
  const outcome = await runManualFanoutDispatch(parent, templatePlan.plan, signal);
  if (outcome.ok !== true) { fail(outcome.status, outcome.code, outcome.message, outcome.details); return; }
  send(200, { ok: true, templateId, ...outcome.receipt });
  return;
}

/**
 * 「fanout-restore-retry」 的 handler（原始源行归属 2542–2598）。
 */
async function handleFanoutRestoreRetry(deps, req) {
  const {
    consumeFanoutRestore, fanoutRpcRootSession, fanoutRpcSessionId, refreshFanoutSnapshotFromStorage,
    rehydrateFanoutOwnership
  } = deps.fanout;
  const { expertGroupRuntime, fanoutHost } = deps.reads;
  const { body, send, fail } = req;

  if (body.action === "fanout-restore-retry") {
    /**
     * 恢复重试（票据 04）：重新读取**当前**持久化快照并重跑恢复。
     *
     * 授权边界：只允许 live root（复用 fanoutRpcRootSession 的同一套判定：非空、不是
     * 任何子会话、不是 DEG 记录的 child、且 registry 里有 live Agent）。理由：
     * 1. restore 会把任务重新放回 manager 并绑定 ownership，属于**写运行时状态**的操作，
     *    必须与 cancel/retry 等写动作使用同一 fail-closed 边界；
     * 2. 恢复后的归属绑定只认 exact live root Agent（getAgent(parentId)）；没有 live root 时
     *    需要 root 的 queued 任务只能进 deferred，这次重试对它们等于没有恢复；
     * 3. 该动作读取的是**全局**持久化快照（不按 root 过滤），若允许任意/冷 sessionId 触发，
     *    就等于把一次宿主级恢复交给无法证明身份的调用方。冷 root 场景由下一次真实
     *    agent/created（root 上线）自动重跑恢复，不依赖这条 RPC。
     *
     * 关键约束：本动作**只读 storage**，绝不写持久化数据；失败时保持 fail-closed 闸门与
     * 同一原因码，成功时由 restore() 自己清除闸门。
     */
    const sessionId = fanoutRpcSessionId(body);
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    if (fanoutRpcRootSession(sessionId) === void 0) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    if (typeof fanoutHost === "undefined" || fanoutHost === null || typeof fanoutHost.restore !== "function") {
      fail(503, "restore-unavailable", "fan-out 恢复入口不可用");
      return;
    }
    // 读当前持久化快照（只读）→ 补齐缺失的归属寻址 → 重跑恢复。
    const persistedSnapshot = refreshFanoutSnapshotFromStorage();
    rehydrateFanoutOwnership(persistedSnapshot);
    const outcome = consumeFanoutRestore("rpc-restore-retry", fanoutHost.restore());
    const failure = outcome?.ok === true ? null : (outcome?.error ?? null);
    const errorCode = typeof failure?.code === "string" && failure.code.length > 0 ? failure.code : null;
    // 恢复状态变化必须立刻反映到下一次快照：否则 5s 的完整快照缓存会把旧 recovery 块
    // 继续返回给侧栏（错误横幅在成功重试后仍然挂着）。失效只影响缓存代次，不写 storage。
    expertGroupRuntime.invalidateSnapshots(sessionId);
    send(200, {
      ok: true,
      sessionId,
      // restored 表示「本次确实恢复了至少一个任务」；ok 仍是 RPC 信封层语义
      // （请求被接受并执行），与既有 fanout-* RPC 的 accepted 语义一致。
      restored: outcome?.ok === true,
      restoredCount: Number.isSafeInteger(outcome?.restored) ? outcome.restored : 0,
      deferred: Number.isSafeInteger(outcome?.deferred) ? outcome.deferred : 0,
      pending: outcome?.pending === true,
      // 失败原因码是稳定的机器 token；message 只用于诊断文案（客户端再受限显示）。
      // 没有失败细节（例如磁盘上已没有可恢复快照）时为 null，绝不伪造原因码。
      error: failure === null || errorCode === null
        ? null
        : {
          code: errorCode,
          message: typeof failure.message === "string" ? failure.message : "",
          retryable: restoreFailureRetryable(errorCode),
        },
    });
    return;
  }
}

/**
 * 「fanout-reclaim」 的 handler（原始源行归属 2600–2742）。
 */
async function handleFanoutReclaim(deps, req) {
  const {
    fanoutCaches, fanoutRpcIsChildSession, fanoutRpcRootSession, fanoutRpcSessionId, fanoutWaits
  } = deps.fanout;
  const { expertGroupRuntime, fanoutHost } = deps.reads;
  const { body, send, fail } = req;

  if (body.action === "fanout-reclaim") {
    /**
     * 显式回收已结算父任务（票据 05）。
     *
     * 授权边界与其它写动作同源：只允许 live root（子会话/未知/已销毁 root 一律 404），
     * 且逐项按归属过滤——非归属与未知 id 都返回 skipped reason=not_owner，不泄露存在性。
     * 仍被 root 等待账本（fanoutTurnWaitRecords）引用的任务先跳过：回收后该任务不会再
     * 产生 task_settled，等待项会永久悬挂。
     *
     * 持久化语义由 fanoutHost.reclaimTasks 负责（先落盘成功再移除）：落盘失败返回 500
     * 稳定 code reclaim-persist-failed，内存状态不变；其余"无任务可回收/输入被拒"
     * 仍是 200 + 逐项 skipped（成功语义的"什么都没做"）。
     */
    const sessionId = fanoutRpcSessionId(body);
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    if (fanoutRpcIsChildSession(sessionId)) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    const parent = fanoutRpcRootSession(sessionId);
    if (parent === void 0) { fail(404, "session-not-found", "根会话不存在或尚未恢复"); return; }
    if (typeof fanoutHost === "undefined" || fanoutHost === null || typeof fanoutHost.reclaimTasks !== "function") {
      fail(503, "reclaim-unavailable", "fan-out 回收入口不可用");
      return;
    }
    if (!Array.isArray(body.parentTaskIds)) { fail(400, "bad-request", "parentTaskIds 必须是数组"); return; }
    const reclaimIds = [];
    const reclaimSeen = new Set();
    for (const raw of body.parentTaskIds) {
      const parentTaskId = typeof raw === "string" ? raw.trim() : "";
      if (parentTaskId.length === 0) { fail(400, "bad-request", "parentTaskIds 只能包含非空字符串"); return; }
      if (reclaimSeen.has(parentTaskId)) continue;
      reclaimSeen.add(parentTaskId);
      reclaimIds.push(parentTaskId);
    }
    if (reclaimIds.length === 0) { fail(400, "bad-request", "parentTaskIds 不能为空"); return; }
    if (reclaimIds.length > MAX_RECLAIM_BATCH) {
      fail(400, "bad-request", "单次最多回收 " + MAX_RECLAIM_BATCH + " 个父任务");
      return;
    }
    const reclaimSkipped = [];
    const reclaimable = [];
    for (const parentTaskId of reclaimIds) {
      // 未释放的 goal handoff：回收会让它的等待永远无法结算。
      const waitRecord = fanoutWaits?.handoffRecordState(parentTaskId);
      if (waitRecord !== undefined && waitRecord.state !== "released") {
        reclaimSkipped.push({ parentTaskId, reason: "referenced_by_wait" });
        continue;
      }
      const owner = typeof fanoutHost.ownerOf === "function" ? fanoutHost.ownerOf(parentTaskId) : null;
      if (owner === sessionId) {
        /**
         * 写权限边界（票据 09）：归属命中还不够——回收会删除任务，必须由**当前代际
         * 的 exact live 写绑定**授权。冷恢复的已结算任务（restore 已归还归属、绑定
         * 释放）与同 id replacement root（owner 字符串相同、绑定对象是旧代际）都只有
         * 读权限，这里给逐项 skipped.reason="owner_not_live"，不进入回收。
         * host.reclaimTasks 内部还有同一条件的防御性复核（双保险）。
         */
        const hasLiveWrite = typeof fanoutHost.hasLiveWriteBinding === "function"
          && fanoutHost.hasLiveWriteBinding(parent, parentTaskId) === true;
        if (hasLiveWrite !== true) {
          reclaimSkipped.push({ parentTaskId, reason: "owner_not_live" });
          continue;
        }
        reclaimable.push(parentTaskId);
        continue;
      }
      // 已回收（归属提示命中本 root）→ task_not_found；其余统一 not_owner（不泄露存在性）。
      const reclaimedOwner = typeof fanoutHost.reclaimedOwnerOf === "function"
        ? fanoutHost.reclaimedOwnerOf(parentTaskId)
        : null;
      reclaimSkipped.push({
        parentTaskId,
        reason: owner === null && reclaimedOwner === sessionId ? "task_not_found" : "not_owner",
      });
    }
    if (reclaimable.length === 0) {
      // 什么都没做：durable 必须如实为 false（不做任何耐久声明）。
      send(200, { ok: true, sessionId, reclaimed: [], skipped: reclaimSkipped, count: 0, durable: false });
      return;
    }
    const outcome = await fanoutHost.reclaimTasks(parent, reclaimable);
    if (outcome?.accepted !== true) {
      const reason = typeof outcome?.reason === "string" ? outcome.reason : "reclaim_not_accepted";
      const mergedSkipped = [...reclaimSkipped, ...(Array.isArray(outcome?.skipped) ? outcome.skipped : [])];
      if (reason === "persist_failed") {
        // 落盘失败：内存状态不变（manager 已 abortReclaim），因此可安全重试。
        fail(500, "reclaim-persist-failed", "fan-out 回收未能落盘，任务保持不变，可稍后重试", {
          skipped: mergedSkipped,
          ...(typeof outcome?.category === "string" && outcome.category.length > 0
            ? { category: outcome.category }
            : {}),
        });
        return;
      }
      if (reason === "reclaim_in_progress" || outcome?.code === "RECLAIM_IN_PROGRESS") {
        fail(409, "reclaim-in-progress", "已有回收正在进行中，请稍后重试");
        return;
      }
      if (reason === "runtime_closed" || outcome?.code === "RUNTIME_CLOSED") {
        fail(503, "reclaim-unavailable", "fan-out 回收入口不可用");
        return;
      }
      // 其它拒绝（无任务可回收 / 输入被 manager 拒绝 / 候选快照闸门）：什么都没变。
      send(200, {
        ok: true,
        sessionId,
        reclaimed: [],
        skipped: mergedSkipped,
        count: 0,
        rejected: reason,
        // 什么都不曾落盘：绝不宣称耐久结果。
        durable: false,
      });
      return;
    }
    const reclaimed = Array.isArray(outcome.reclaimed) ? outcome.reclaimed : [];
    // 已回收任务的等待记录若已 released，顺手清掉：它们已不可寻址，留着只会占满有界表。
    for (const parentTaskId of reclaimed) {
      fanoutCaches.clearFanoutOutputSchemas(parentTaskId);
      fanoutCaches.clearFanoutRoute(parentTaskId);
      fanoutWaits?.forgetReleasedHandoffRecord(parentTaskId);
    }
    // 侧栏快照必须立刻反映回收结果（否则 5s 缓存会继续显示已回收任务）。
    expertGroupRuntime.invalidateSnapshots(sessionId);
    /**
     * 耐久结果如实透出（票据 05 第三轮）：
     * - durable:true —— 候选与最终快照都真实落盘，磁盘已收敛；
     * - durable:false + durabilityReason:"final_snapshot_failed" —— 回收已提交
     *   （内存与侧栏已移除任务），但最终快照写入失败，磁盘可能仍停留在关闭期旧快照的
     *   位置（它已被进程内排除集合过滤，因此不会复活任务，但也不能声称耐久成功）。
     */
    send(200, {
      ok: true,
      sessionId,
      reclaimed,
      skipped: [...reclaimSkipped, ...(Array.isArray(outcome.skipped) ? outcome.skipped : [])],
      count: reclaimed.length,
      durable: outcome?.durable === true,
      durabilityReason: typeof outcome?.durabilityReason === "string" ? outcome.durabilityReason : null,
    });
    return;
  }
}

/**
 * 「fanout-list」 / 「fanout-get」 / 「fanout-events」 / 「fanout-cancel-shard」 / 「fanout-cancel-parent」 / 「fanout-retry-shard」 / 「fanout-retry」 的 handler（原始源行归属 2744–2902）。
 */
async function handleFanoutTaskActions(deps, req) {
  const {
    fanoutCaches, fanoutRpcAfter, fanoutRpcCapabilitiesOf, fanoutRpcIsChildSession, fanoutRpcOwnerOf,
    fanoutRpcReadRootSession, fanoutRpcRootSession, fanoutRpcSendOwnerNotLive, fanoutRpcSessionId,
    fanoutRpcTaskWithCapabilities, fanoutWaits
  } = deps.fanout;
  const { fanoutHost } = deps.reads;
  const { body, send, fail } = req;

  if (body.action === "fanout-list" || body.action === "fanout-get" || body.action === "fanout-events"
    || body.action === "fanout-cancel-shard" || body.action === "fanout-cancel-parent"
    || body.action === "fanout-retry-shard" || body.action === "fanout-retry") {
    const sessionId = fanoutRpcSessionId(body);
    if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
    /**
     * 读写根解析拆分（票据 09）：
     * - 读动作（list/get/events）：live root，或「root 不在线但仍有已归属任务」的冷恢复根；
     * - 写动作：必须 live root；冷恢复根在「任务已知」时返回 200 + owner_not_live，
     *   非归属/未知任务一律 404，且不得借错误码泄露跨 root 的任务存在性。
     */
    const writeAction = body.action === "fanout-cancel-shard" || body.action === "fanout-cancel-parent"
      || body.action === "fanout-retry-shard" || body.action === "fanout-retry";
    if (writeAction !== true && fanoutRpcReadRootSession(sessionId) !== true) {
      fail(404, "session-not-found", "根会话不存在或尚未恢复");
      return;
    }
    if (writeAction === true) {
      // 子会话永远不能以 root 身份写任务（先于归属判定，避免用错误码区分身份）。
      if (fanoutRpcIsChildSession(sessionId)) {
        fail(404, "session-not-found", "根会话不存在或尚未恢复");
        return;
      }
      const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId.trim() : "";
      if (parentTaskId.length === 0) { fail(400, "bad-request", "缺少 parentTaskId"); return; }
      // 归属判定先于任务存在性：非归属 root 连「任务是否存在」都不可探测。
      if (fanoutRpcOwnerOf(parentTaskId) !== sessionId) {
        fail(404, "not-found", "fan-out 父任务不存在或不属于当前根会话");
        return;
      }
      const task = fanoutHost.getTask(parentTaskId);
      if (task === null) {
        // 归属索引仍指向本根但 manager 已无任务 = 已回收任务（票据 05/09 同一语义）。
        fail(404, "task_not_found", "fan-out 父任务已不存在");
        return;
      }
      const parent = fanoutRpcRootSession(sessionId);
      /**
       * 写授权硬条件（票据 09）：live root + exact parent Agent + 绑定代际 token。
       * 冷恢复根（parent undefined）与同 id replacement（exact Agent/token 不匹配）
       * 都落到同一回执：任务仍可按读权限返回，但写动作不被执行。
       */
      if (parent === void 0
        || typeof fanoutHost?.hasLiveWriteBinding !== "function"
        || fanoutHost.hasLiveWriteBinding(parent, parentTaskId) !== true) {
        fanoutRpcSendOwnerNotLive(send, sessionId, parentTaskId, task);
        return;
      }
      // 授权成立：执行 manager 的真实写入口，动作级原因（stop_unconfirmed 等）由它给出。
      let result;
      if (body.action === "fanout-cancel-parent") {
        result = fanoutHost.cancelParent(parentTaskId);
        // 取消后的任务没有 retry 路径：与 outputSchema 映射同生命周期清理，
        // 避免已取消任务的预检路由占满有界表（重新提交会得到新 parentTaskId）。
        if (result?.accepted === true) fanoutCaches.clearFanoutRoute(parentTaskId);
      } else {
        const shardId = typeof body.shardId === "string" ? body.shardId.trim() : "";
        if (shardId.length === 0) { fail(400, "bad-request", "缺少 shardId"); return; }
        result = body.action === "fanout-cancel-shard"
          ? fanoutHost.cancelShard(parentTaskId, shardId)
          : fanoutHost.retryShard(parentTaskId, shardId);
      }
      const retriedTask = fanoutHost.getTask(parentTaskId);
      // 手工重试会把已终态任务带回 pending（fanout.js 的 retryShard 是唯一入口，
      // 只有本 RPC 调用它），而首次 settle 时该父任务**上一代次**的等待工作已经结算。
      // 若这里不重新登记，root turn 就没有任何等待依据，会在重试的分片跑完前收口。
      //
      // 登记走**新代次**（fanout:<parentTaskId>:<attempt+1>），而不是复用旧键：复用旧键
      // 会让「retry 期间的新工作」与「已结算的旧工作」无法区分，从而在分片跑完前放行。
      // retry 成功后的任务是 pending，不会被终态守卫跳过；同 root 的 duplicate submit
      // 仍由 records 的未释放状态幂等短路。retry 任务成功/失败/取消都会由 manager 聚合
      // 出 task_settled → releaseFanoutGoalHandoff 结算它自己的代次。
      if (result?.accepted === true && (body.action === "fanout-retry-shard" || body.action === "fanout-retry")) {
        fanoutWaits.registerFanoutRetryGoalHandoff(parent, parentTaskId, retriedTask);
      }
      // 回执附带与 get/list/snapshot 同源的逐动作能力：客户端在动作后无需猜测新状态。
      const capabilities = fanoutRpcCapabilitiesOf(sessionId, parentTaskId);
      send(200, {
        ok: true,
        ...result,
        task: fanoutRpcTaskWithCapabilities(sessionId, retriedTask),
        ...(capabilities === null ? {} : { capabilities }),
      });
      return;
    }
    if (body.action === "fanout-list") {
      // 唯一归属入口：fanoutHost.tasksOwnedBy（活动绑定 + 已结算只读索引）。
      // 每个任务附带同一份能力投影，与侧栏快照保持逐字段一致。
      const tasks = fanoutHost.tasksOwnedBy(sessionId)
        .map((task) => fanoutRpcTaskWithCapabilities(sessionId, task));
      const eventBatch = fanoutHost.getEvents({ after: 0 });
      send(200, { ok: true, sessionId, tasks, cursor: eventBatch.nextSequence });
      return;
    }
    if (body.action === "fanout-events") {
      const after = fanoutRpcAfter(body.after);
      const hasParentTaskId = body.parentTaskId !== undefined;
      const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId.trim() : "";
      if (hasParentTaskId && parentTaskId.length === 0) {
        fail(400, "bad-request", "parentTaskId 无效");
        return;
      }
      // root-wide 查询不要求 parentTaskId；指定父任务时先做同一 ownership 校验，
      // 不能用事件自身字段绕过旧 root/new root 隔离。归属匹配但任务已回收 →
      // task_not_found（与 get/写动作同一语义）；非归属 → not-found（不泄露存在性）。
      if (hasParentTaskId) {
        if (fanoutRpcOwnerOf(parentTaskId) !== sessionId) {
          fail(404, "not-found", "fan-out 父任务不存在或不属于当前根会话");
          return;
        }
        if (fanoutHost.getTask(parentTaskId) === null) {
          fail(404, "task_not_found", "fan-out 父任务已不存在");
          return;
        }
      }
      const batch = fanoutHost.getEvents({
        after,
        ...(hasParentTaskId ? { parentTaskId } : {}),
      });
      const events = hasParentTaskId
        ? batch.events
        // root-wide 事件只保留**仍存在**的本 root 任务：已回收任务的历史事件虽然还在
        // Host 日志里（审计用途），但任务本身已不存在，不应再按 root 查询返回。
        : batch.events.filter((event) => fanoutRpcOwnerOf(event.parentTaskId) === sessionId
          && (typeof fanoutHost?.reclaimedOwnerOf === "function"
            ? fanoutHost.reclaimedOwnerOf(event.parentTaskId) === null
            : true));
      // gap 字段来自 Host 的**全局**事件日志（与 parentTaskId 过滤无关）：客户端据此
      // 判断 cursor 是否已早于保留窗口，避免把"读不到旧事件"误当成"没有新事件"。
      send(200, {
        ok: true,
        events,
        cursor: batch.nextSequence,
        earliestSequence: batch.earliestSequence ?? null,
        gap: batch.gap === true,
        dropped: Number.isSafeInteger(batch.dropped) ? batch.dropped : 0,
      });
      return;
    }
    // fanout-get
    const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId.trim() : "";
    if (parentTaskId.length === 0) { fail(400, "bad-request", "缺少 parentTaskId"); return; }
    if (fanoutRpcOwnerOf(parentTaskId) !== sessionId) {
      fail(404, "not-found", "fan-out 父任务不存在或不属于当前根会话");
      return;
    }
    const task = fanoutHost.getTask(parentTaskId);
    if (task === null) {
      fail(404, "task_not_found", "fan-out 父任务已不存在");
      return;
    }
    const capabilities = fanoutRpcCapabilitiesOf(sessionId, parentTaskId);
    send(200, {
      ok: true,
      task: fanoutRpcTaskWithCapabilities(sessionId, task),
      ...(capabilities === null ? {} : { capabilities }),
    });
    return;
  }
}

/**
 * 「settings-commit」 的 handler（原始源行归属 2903–2916）。
 */
async function handleSettingsCommit(deps, req) {
  const { commitSettingsCandidate } = deps.services;
  const { body, signal, send, fail } = req;

  if (body.action === "settings-commit") {
    const expectedRevision = body.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail(400, "bad-request", "expectedRevision 无效");
      return;
    }
    // 兼容旧 Host 的调用形状：commitSettingsCandidate(body.settings, expectedRevision);
    // 票据 20：`changed` 是可选的变更集（新客户端携带 `string[]`，旧客户端不携带，
    // Host 会按「已保存值 vs 候选」的差异自行推导）。候选本身仍是完整值，
    // replace 语义与 revision 栅栏完全不变。
    const committed = await commitSettingsCandidate(body.settings, expectedRevision, signal, body.changed);
    send(200, { ok: true, ...committed });
    return;
  }
}

/**
 * 「notification-test」 的 handler（原始源行归属 2917–2954）。
 */
async function handleNotificationTest(deps, req) {
  const {
    logSystemToastFailure, systemToast, systemToastDiagnosticToken, systemToastEnabled,
    systemToastPlatformToken, systemToastVolume,
    // 展开运算符（...testNotificationToast()）在依赖扫描里是"值使用"，这里显式解构。
    testNotificationToast,
  } = deps.notifications;
  const { body, send, fail } = req;

  /**
   * 「发送测试通知」动作（票据 14）。
   *
   * 唯一通道是 config.createSystemToast 创建的真实适配器：这里直接调用它的
   * show()，绝不伪造任务状态、不创建假任务、不写终止快照，也不绕过平台适配器
   * 自己拼 XML/子进程。回执只给出平台固定枚举、是否真的显示与适配器声明的
   * reason token；桌面上的真实显示/发声仍属人工验收（见票据）。
   *
   * 开关语义：通知总开关关闭时**不发送**（与后台投递同一约束），回执 reason=disabled；
   * 事件类型过滤不适用于测试动作——用户显式点击就是要求验证通道。
   */
  if (body.action === "notification-test") {
    const platform = systemToastPlatformToken();
    if (systemToastEnabled() !== true) {
      send(200, { ok: true, test: { shown: false, reason: "disabled", platform } });
      return;
    }
    if (typeof systemToast?.show !== "function") {
      fail(503, "notification-unavailable", "系统通知通道不可用");
      return;
    }
    let result;
    try {
      result = await systemToast.show({
        ...testNotificationToast(),
        // 与后台投递共用同一份音量设置；测试动作不改变任何设置。
        volume: systemToastVolume(),
      });
    } catch (error) {
      logSystemToastFailure(error);
      fail(502, "notification-failed", "系统通知投递失败");
      return;
    }
    // 注入实现可能返回自由文本：reason 只接受模块声明过的固定 token。
    const reason = systemToastDiagnosticToken(result?.reason) ?? "unknown";
    send(200, { ok: true, test: { shown: result?.shown === true, reason, platform } });
    return;
  }
}
