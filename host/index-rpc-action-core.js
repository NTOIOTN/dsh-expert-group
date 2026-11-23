/**
 * RPC action 分发核心（R4f · 票据 20）——共享响应适配器、传输无关分发器与「无会话域」action。
 *
 * 拆分口径（见 docs/tickets/module-decomposition/20-index-R4f-RPC-action-分发拆分.md 的映射表）：
 * 本模块持有 23 个 action 的 handler（image / meta / snapshot / settings / notification / 会话删除），
 * 以及分发器的全部共用件：
 * ① 共享响应适配器 createRpcActionResponder（成功 send / 失败 fail 的统一 envelope 构造与
 *    错误类别记录）——全仓唯一一份，会话域模块只通过 per-request 的 { send, fail } 窄面消费；
 * ② mapRpcError（结构化错误 → (status, code, message, details) 的唯一映射），legacy HTTP
 *    adapter 与 Connection 通道共用同一次映射，不允许第二个副本；
 * ③ dispatchRpcAction（取消/请求体/尺寸闸门 + 动作分发表 + 未知动作 + 错误收敛）。
 *
 * 依赖形状：deps 按协作方分 7 组（services / reads / image / notifications / runtime /
 * diagnostics / session），handler 只解构自己那几组；不接收 ctx。
 * 注册点、register 顺序与 disposer 顺序一律仍留在 index.js（票据 20 铁律 1/2）。
 */
import { abortErrorFor, createAbortError, throwIfAborted } from "./rpc-request-lifecycle.js";
import {
  projectInheritContextDiagnostics,
  projectModelPriceDiagnostics,
  projectPeakValleyDiagnostics,
} from "./settings-read-projection.js";
import { effectiveRoleDefaultsOf, PEAK_VALLEY_ERROR_CODES } from "./peak-valley-settings.js";
import { decideImageRoute, imageCapability } from "../image-routing.js";
import { roleDescriptionsOf } from "../shared/protocol.js";
import { BadJsonError, PayloadTooLargeError, RPC_ERROR_CODES } from "./index-rpc-http.js";
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
  ["settings-commit", handleSettingsCommit],
  ["notification-test", handleNotificationTest],
  // 会话删除（票据 04）：两个 action 都**不要求 sessionId**，因此属于无会话域分发表。
  // 命令面（校验/编排/错误码）在 host/session-delete-rpc，这里的 handler 只做 envelope。
  ["session-delete-candidates", handleSessionDeleteAction],
  ["session-delete", handleSessionDeleteAction],
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
      fail(413, RPC_ERROR_CODES.PAYLOAD_TOO_LARGE, "请求体超过允许上限");
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
    return { status: 499, code: RPC_ERROR_CODES.CANCELLED, message: "请求已取消" };
  }
  if (error instanceof PayloadTooLargeError || host.rpc.isBodyTooLarge(error)) {
    return { status: 413, code: RPC_ERROR_CODES.PAYLOAD_TOO_LARGE, message: "请求体超过允许上限" };
  }
  if (error instanceof BadJsonError) {
    return { status: 400, code: "bad-request", message: error.message };
  }
  // 会话删除（票据 04）：候选查询/删除执行的稳定错误码（400/404/409/503）由该域自己映射一次，
  // 这里只负责采纳——错误映射仍然只有这一条路径，不产生第二份副本。
  const sessionDeleteMapped = deps.session?.sessionDelete?.mapError?.(error);
  if (sessionDeleteMapped !== undefined) return sessionDeleteMapped;
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
  if (typeof error?.code === "string" && PEAK_VALLEY_ERROR_CODES.includes(error.code)) {
    // 峰谷（票据 02）：三个稳定错误码必须**原值直达**客户端，客户端据此区分
    // 「时段非法 / profile 非法 / 状态非法」并就地提示；状态仍是 400（客户端输入问题），
    // message 只含原因、不回显原始配置。白名单之外的一切 ValidationError 行为不变。
    return { status: 400, code: error.code, message: error.message };
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
  return { status: 500, code: RPC_ERROR_CODES.INTERNAL, message: "内部错误，请查看服务端日志" };
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
    activeRoles, describeRolePrompts, roleCatalog, roleLabelsProjection, source,
    usageSummaryFor, hostCapacityProjection
  } = deps.reads;
  const { config } = deps.services;
  const { body, send } = req;

  if (body.action === "meta") {
    // 设置页不绑定具体会话：角色状态必须来自 Host 配置，避免 child/no-session 误判 Observer。
    const roles = activeRoles();
    const snap = source();
    send(200, {
      ok: true,
      roles,
      activeRoles: roles,
      // 角色只读投影：客户端据此渲染设置页角色表与侧栏标签；
      // roleLabels 是显示名（英文，与角色状态标签一致），roleDescriptions 是职责摘要（设置页提示）。
      roleLabels: roleLabelsProjection(),
      // 「会话模型」的默认读面：峰谷启用时返回**当前时段**生效的逐角色默认（时段层优先、
      // 缺角色回退普通层），未启用/配置损坏时就是普通层 snap.defaults。侧边栏据此显示
      // 「跟随默认」。这里只是只读投影，不改 get/session-override-* 的任何行为。
      roleDefaults: effectiveRoleDefaultsOf(snap),
      roleDescriptions: roleDescriptionsOf(roleCatalog().records()),
      enableObserver: config.enableObserver === true,
      observerPreferred: snap.observerPreferred === true,
      // 宿主子代理名额（只读投影）：读不到名额时为 null（不伪造数字）。
      // 旧装配缺少该窄命令时整块省略（不伪造字段）。
      //
      // 惰性兼容输入：fan-out 时代遗留的 roleConcurrencyLimit / roleLimits /
      // providerLimits / roleTimeoutMs **不再出现在 meta**。旧 settings 文档里的这些值
      // 既不参与读取归一，也不因此报错——它们只是留在磁盘上的历史键。
      ...(typeof hostCapacityProjection === "function" ? hostCapacityProjection() : {}),
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
       * 峰谷（票据 02）：只回传归一后的状态（enabled/initialized/periods/peak/valley），
       * 启用但非法时另带 invalidCode 供设置页提示与派发路径 fail-closed。
       * 诊断与其它读取期丢弃诊断同款：有界、只读、不是可回写配置。
       */
      peakValley: snap.peakValley,
      peakValleyDiagnostics: projectPeakValleyDiagnostics(snap.peakValleyDiagnostics),
      /**
       * 主代理模型配置（批次 A）：全局层 `{ defaults, candidates, fallbackLimit }`。
       * defaults 为 null = 未配置（不干预）；峰/谷两层的对应配置随
       * peakValley.peak/valley 一起回传（shape 相同，不再额外投影一份）。
       * 诊断与其它读取期丢弃诊断同款：有界、只读、不是可回写配置。
       */
      orchestrator: snap.orchestrator,
      orchestratorDiagnostics: Array.isArray(snap.orchestratorDiagnostics) ? snap.orchestratorDiagnostics : [],
      /**
       * 用量聚合（票据 25，全局只读）：totals / byRole / byProvider / byModel /
       * recentTasks（≤16）。只由 child_models.usage 与 live 账本投影，不含
       * prompt/response/凭据/完整路径；没有样本时 totals 为 null，不补 0。
       */
      usage: usageSummaryFor(null),
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
 * 「session-delete-candidates」 / 「session-delete」 的 handler（票据 04）。
 *
 * 两个 action 都不要求 sessionId，因此登记在无会话域分发表；输入校验、五态聚合与稳定错误码
 * 都在 `host/session-delete-rpc`（由 `deps.session.sessionDelete` 提供）。这里只把解码后的
 * body 交给命令面，并在成功时补上共享 envelope 的 `ok:true`——分发表里不写业务。
 */
async function handleSessionDeleteAction(deps, req) {
  const { body, send } = req;
  const result = await deps.session.sessionDelete.handle(body.action, body);
  send(200, { ok: true, ...result });
}

/**
 * 「settings-commit」 的 handler（原始源行归属 2903–2916）。
 */
async function handleSettingsCommit(deps, req) {
  const { commitSettingsCandidate } = deps.services;
  const { noteOrchestratorSettingsCommit } = deps.reads;
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
    /**
     * 主代理模型配置（批次 A）：保存成功后的**唯一**动作是推进"未来新会话的配置修订"
     * 并重排峰谷边界定时器。刻意不遍历已存在会话、不重新套用任何模型——
     * 产品语义是"保存只影响之后新建的会话"。失败也不影响保存结果（它只是诊断+定时器），
     * 因此这里吞掉异常并保持响应形状不变。
     */
    try {
      noteOrchestratorSettingsCommit?.();
    } catch {
      // 定时器/统计失败不能把一次已经落盘的保存变成 500。
    }
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
