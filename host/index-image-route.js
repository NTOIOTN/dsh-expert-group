/**
 * 入口图片路由的 wire 校验与路由证据解析（R4e · 票据 19）。
 *
 * 这一域只做**无副作用的校验与投影**：
 * - 客户端上传项的严格 wire shape（只接受 type/mediaType/data/name，拒绝 pngPath、
 *   data URL 与未知扩展字段）与 canonical base64 解码；
 * - image-route / -validate / -observer-commit / -observer-cancel / -observer-release
 *   五个动作的严格对象契约（未知字段一律 400，不静默忽略）；
 * - “下一个请求将使用的模型路由”的只读取证（下一请求 vs 已发出请求的 header）；
 * - 图片路由的三态能力诊断投影。
 *
 * 所有校验失败都抛 `ValidationError`（`index.js` 中声明的同一个类，经参数注入），
 * 因此仍然映射为 400 invalid-selection，而不是退化成 500 internal。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不持状态、不注册：本模块是纯函数集合，供 dispatcher 与 claims 域调用。
 *
 * @module dsh-expert-group/host/index-image-route
 */

/**
 * 创建图片路由 wire 能力面。
 *
 * @param {object} deps - 窄能力面（2 组）。
 * @param {Function} deps.ValidationError - 入口声明的校验错误类（类身份必须唯一，
 *   否则 `mapRpcError` 的 instanceof 判定会退化为 500 internal）。
 * @param {Function} deps.effectiveModelRoute - image-routing 的路由证据判定（纯函数）。
 * @returns {object} 校验/取证能力面。
 */
export function createImageRouteWire({ ValidationError, effectiveModelRoute }) {
  /** 严格解码客户端上传的 canonical base64，避免宽松 Buffer 解码接收脏数据。 */
  function decodeImageBase64(value) {
    if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new ValidationError("图片 data 不是合法 base64");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== value) {
      throw new ValidationError("图片 data 必须是 canonical base64");
    }
    return new Uint8Array(bytes);
  }

  /**
   * 校验一个 image-route 上传项的完整 wire shape。图片上传只接受 client
   * serializer 产生的四个字段，尤其拒绝 pngPath、data URL 和未知扩展字段；
   * 路径永远不能由客户端指定，PNG durable copy 只能由 Host 的 attachments 服务创建。
   */
  function validateEncodedImageInput(input) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new ValidationError("图片上传项必须是对象");
    }
    const keys = Object.keys(input);
    if (keys.some((key) => !["type", "mediaType", "data", "name"].includes(key))) {
      throw new ValidationError("图片上传项包含不支持的字段");
    }
    if (input.type !== "image") throw new ValidationError("图片上传项 type 必须为 image");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mediaType)) {
      throw new ValidationError("图片 mediaType 不受支持");
    }
    if (input.name !== void 0 && (typeof input.name !== "string" || input.name.length > 255
      || /[\x00-\x1f\x7f]/.test(input.name))) {
      throw new ValidationError("图片 name 无效");
    }
    return {
      mediaType: input.mediaType,
      data: decodeImageBase64(input.data),
      name: input.name,
    };
  }

  /** image-route 自身也采用严格对象契约，避免 pngPath 等旁路字段被静默忽略。 */
  function validateImageRouteBody(body) {
    const keys = Object.keys(body);
    if (keys.some((key) => !["action", "sessionId", "text", "images"].includes(key))) {
      throw new ValidationError("图片路由请求包含不支持的字段");
    }
    if (body.text !== void 0 && typeof body.text !== "string") {
      throw new ValidationError("图片路由 text 必须是字符串");
    }
    if (!Array.isArray(body.images)) throw new ValidationError("图片路由 images 必须是数组");
  }

  /**
   * image-route-validate / image-route-observer-commit 的严格对象契约：
   * 只接受 action/sessionId/routeClaim 三个字段，routeClaim 必须是非空字符串。
   * 长度/归属/是否过期由 claim 表结构校验负责，这里只保证 wire 形状，
   * 避免任意字段被静默忽略。
   * @param {object} body - 已解码的请求体。
   * @param {string} label - 用于错误文案的动作名（中文可读）。
   */
  function validateImageRouteClaimBody(body, label) {
    const keys = Object.keys(body);
    if (keys.some((key) => !["action", "sessionId", "routeClaim"].includes(key))) {
      throw new ValidationError(label + "请求包含不支持的字段");
    }
    if (typeof body.routeClaim !== "string" || body.routeClaim.length === 0) {
      throw new ValidationError(label + "缺少 routeClaim");
    }
  }

  /** image-route-validate 的 wire 契约。 */
  function validateImageRouteValidateBody(body) {
    validateImageRouteClaimBody(body, "图片路由校验");
  }

  /**
   * image-route-observer-commit 的 wire 契约。
   *
   * 与 image-route-validate 同形（action/sessionId/routeClaim），因此两条传输上的
   * 错误结构完全一致：route-changed → 409、route-claim-invalid/route-commit-in-progress → 409/400，
   * 客户端只需按同一套规则 abandon。
   */
  function validateImageRouteCommitBody(body) {
    validateImageRouteClaimBody(body, "图片路由提交");
  }

  /**
   * image-route-observer-cancel / image-route-observer-release 的严格 wire 契约：
   * 只接受 action/sessionId/childId/cleanupToken。与 claim 相关动作一样严格：
   * 未知字段与缺失字段都是 400，不做静默忽略。
   */
  function validateImageRouteTokenBody(body, label) {
    const keys = Object.keys(body);
    if (keys.some((key) => !["action", "sessionId", "childId", "cleanupToken"].includes(key))) {
      throw new ValidationError(label + "请求包含不支持的字段");
    }
    if (typeof body.childId !== "string" || body.childId.length === 0) {
      throw new ValidationError(label + "缺少 childId");
    }
    if (typeof body.cleanupToken !== "string" || body.cleanupToken.length === 0) {
      throw new ValidationError(label + "缺少 cleanupToken");
    }
  }

  /** 失败/取消路径的清理请求契约（会中断 child）。 */
  function validateImageRouteCancelBody(body) {
    validateImageRouteTokenBody(body, "图片路由清理");
  }

  /** 成功 observed 后的凭据释放请求契约（只释放 token，绝不中断 child）。 */
  function validateImageRouteReleaseBody(body) {
    validateImageRouteTokenBody(body, "图片路由释放");
  }

  /**
   * 读取"下一个请求将使用的模型路由"，供图片能力判定使用。
   *
   * 不能直接用 `parent.session.requestHeader()` 判定能力：它是**已发出请求**的模型。
   * 用户切换模型后立即发图时新模型还没进入 prompt assembly，header 仍指向旧模型，
   * 按旧能力路由就会把图片错误地交给 Observer（或错误地留在不支持 image 的主模型）。
   *
   * 公开 seam：DSH Session 的 `snapshotEvents()` 给出 `model/selection`（已校验、待生效）
   * 与 `request/header`（已发出请求）两类事件，取 seq 更大的那个即下一个请求的模型；
   * `effectiveModelRoute` 负责该判定。旧宿主没有事件快照时退回 requestHeader 语义。
   *
   * fail-safe：存在更新的 `model/selection` 但结构不可用时（staleHeaderIgnored），
   * 既不用旧 header 也不用 agent.options —— 二者都可能属于被取代的模型，一律按
   * unknown 保守处理（main-first 不会把图片误判给 Observer）。
   *
   * @param {object} parent - 根会话的在线 agent。
   * @returns {{provider?: string, model?: string, source: string, staleHeaderIgnored: boolean}} 路由证据。
   */
  function resolveMainImageRoute(parent) {
    let headerConfig;
    try {
      headerConfig = parent?.session?.requestHeader?.()?.config;
    } catch {
      headerConfig = void 0;
    }
    let events;
    if (typeof parent?.session?.snapshotEvents === "function") {
      try {
        // 只读公开方法；旧宿主/测试替身可能不实现，返回非数组时同样按"无事件面"处理。
        const snapshot = parent.session.snapshotEvents();
        if (Array.isArray(snapshot)) events = snapshot;
      } catch {
        events = void 0;
      }
    }
    const evidence = effectiveModelRoute({ events, headerConfig });
    if (evidence.provider !== void 0 && evidence.model !== void 0) return evidence;
    if (evidence.staleHeaderIgnored === true) return evidence;
    const options = parent?.options;
    if (typeof options?.provider === "string" && options.provider.length > 0
      && typeof options?.model === "string" && options.model.length > 0) {
      return { provider: options.provider, model: options.model, source: "agent-options", staleHeaderIgnored: false };
    }
    return evidence;
  }

  /**
   * 图片路由的只读能力诊断投影：三态能力 + 路由证据来源，不含 provider/model 明文。
   * 客户端与测试据此区分"按待生效模型判定"和"退回旧请求头"的路径。
   */
  function imageRouteDiagnostics({ mainImage, observerImage, mainRoute }) {
    return {
      main: mainImage,
      mainSource: mainRoute.source,
      mainRouteStaleHeader: mainRoute.staleHeaderIgnored === true,
      observer: observerImage,
    };
  }

  return {
    decodeImageBase64,
    validateEncodedImageInput,
    validateImageRouteBody,
    validateImageRouteClaimBody,
    validateImageRouteValidateBody,
    validateImageRouteCommitBody,
    validateImageRouteTokenBody,
    validateImageRouteCancelBody,
    validateImageRouteReleaseBody,
    resolveMainImageRoute,
    imageRouteDiagnostics,
  };
}
