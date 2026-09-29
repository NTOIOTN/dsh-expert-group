/**
 * 图片路由与 PNG 规范化的无依赖纯函数。
 *
 * 此模块不访问浏览器、文件系统或 DSH 私有实现；Host 仅把公开 attachments
 * 服务的 read/save 包装为回调传入，因此所有边界均可独立 Node 测试。
 * @module dsh-expert-group/image-routing
 */

/** PNG 文件签名；转码回调的结果必须通过此校验，禁止把 JPEG/WebP/GIF 仅改为 .png 后缀。 */
export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * 图片上传输入的客户端错误（HTTP 400 语义）。
 *
 * 与 ImageTranscodeUnavailableError（宿主能力缺失 => 503）区分：这里的问题完全来自
 * 客户端提交的字节——声明的 mediaType 与真实字节不符、字节不是有效 base64 等。
 * Host 的 RPC 层按 code/validation 标记映射为 400 invalid-selection。
 */
export class ImageInputError extends Error {
  constructor(message, { code = "INVALID_IMAGE_INPUT", ...details } = {}) {
    super(message);
    this.name = "ImageInputError";
    this.code = code;
    // validation=true 让 RPC 错误映射无需依赖具体类身份即可识别为客户端输入问题。
    this.validation = true;
    Object.assign(this, details);
  }
}

/** 非 PNG 图片缺少真实转码器时的明确、可恢复失败。调用方必须保留原始输入。 */
export class ImageTranscodeUnavailableError extends Error {
  constructor(mediaType) {
    super(`无法将 ${String(mediaType)} 转换为 PNG：当前插件没有已声明的图片转码器；已保留原始图片，未创建伪造的 .png 副本。`);
    this.name = "ImageTranscodeUnavailableError";
    this.code = "IMAGE_TRANSCODER_UNAVAILABLE";
  }
}

/** 只接受 DSH 当前支持的四种图片 MIME；未知值在路由层保持显式失败。 */
const IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function bytesOf(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} 必须是 Uint8Array`);
  return value;
}

function hasPngSignature(data) {
  return data.byteLength >= PNG_SIGNATURE.byteLength
    && PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function hasDeclaredImageSignature(mediaType, data) {
  if (mediaType === "image/png") return hasPngSignature(data);
  if (mediaType === "image/jpeg") {
    return data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  if (mediaType === "image/webp") {
    return data.byteLength >= 12
      && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50;
  }
  if (mediaType === "image/gif") {
    return data.byteLength >= 6
      && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46
      && data[3] === 0x38 && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61;
  }
  return false;
}


/**
 * 判断一个用户可见名称是否带文件扩展名。opaque attachmentId 不是文件名，
 * 因此没有 name 或 basename 不含有效后缀时均返回 false。
 */
export function hasFileExtension(name) {
  if (typeof name !== "string") return false;
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1;
}

/** 用安全、稳定的显示名称记录无扩展名输入生成的 PNG durable reference。 */
export function pngCopyName(name) {
  if (typeof name !== "string" || name.trim().length === 0) return "image.png";
  const base = name.trim().split(/[\\/]/).pop() ?? "image";
  const stem = base.replace(/[\x00-\x1f<>:\"|?*]/g, "_").replace(/\.+$/, "");
  return (stem.length > 0 ? stem : "image") + ".png";
}

/**
 * 纯函数决定图片是否需要 PNG 副本以及副本操作类型。
 * unknown mediaType 仍返回 transcode 分支，由规范化流程做显式校验/拒绝。
 */
export function decidePngCopy({ mediaType }) {
  // name 只是显示元数据；DSH durable attachmentId 没有可供 read_image 使用的扩展名，
  // 所以任何进入 Observer 的持久图片都必须建立 PNG 副本。
  return { copy: true, operation: mediaType === "image/png" ? "copy-bytes" : "transcode" };
}

/**
 * 将缺少扩展名的图片规范化为一个新的 PNG durable reference。
 * image/png 只复制经过签名校验的原始字节；其他格式必须由调用方提供真实转码器。
 * 此函数不会修改传入的 attachment ref，也不会写任意宿主路径。
 */
export async function toPngBytes({ mediaType, data, transcodeToPng }) {
  if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new TypeError("attachment mediaType 无效");
  const source = bytesOf(data, "图片字节");
  if (!hasDeclaredImageSignature(mediaType, source)) {
    // 客户端输入问题：声明的 mediaType 与真实字节不符。必须显式 400，不得创建副本。
    throw new ImageInputError("图片字节与声明的 mediaType 不匹配", { mediaType, code: "IMAGE_BYTES_MISMATCH" });
  }
  if (mediaType === "image/png") {
    return source.slice();
  }
  if (typeof transcodeToPng !== "function") throw new ImageTranscodeUnavailableError(mediaType);
  const png = bytesOf(await transcodeToPng(source, mediaType), "PNG 转码结果");
  // 转码器是宿主能力：它返回非 PNG 属于宿主侧缺陷，保持 TypeError（500）而非客户端错误。
  if (!hasPngSignature(png)) throw new TypeError("图片转码器没有返回真实 PNG 字节");
  return png;
}

export async function normalizeImageToPng({ attachment, data, transcodeToPng, savePng, forceCopy = false }) {
  if (!attachment || typeof attachment !== "object") throw new TypeError("attachment 无效");
  if (!IMAGE_MEDIA_TYPES.has(attachment.mediaType)) throw new TypeError("attachment mediaType 无效");
  // DSH 本地附件对象本身没有扩展名；Host 传 forceCopy 时即使显示名带后缀也必须复制。
  const copyDecision = decidePngCopy(attachment);
  if (!forceCopy && copyDecision.copy === false) return { attachment, copied: false };
  if (typeof savePng !== "function") throw new TypeError("savePng 必须是函数");
  const png = await toPngBytes({ mediaType: attachment.mediaType, data, transcodeToPng });
  const copied = await savePng({ data: png, mediaType: "image/png", name: pngCopyName(attachment.name) });
  if (!copied || typeof copied !== "object" || copied.mediaType !== "image/png") {
    throw new TypeError("附件服务没有返回 image/png durable reference");
  }
  return {
    attachment: copied,
    copied: true,
    // 附件服务没有公开 delete API；副本随 durable session 引用保留，由 Host 的
    // attachment retention/GC 回收不可达对象，插件不会擅自删除或改写原始 ref。
    lifecycle: "durable-until-unreferenced",
  };
}

/** 将目录元数据转换为三态能力，异常、缺失和格式异常都保留 unknown。 */
export function imageCapability(modelInfo) {
  const modalities = modelInfo?.inputModalities;
  if (!Array.isArray(modalities) || !modalities.every((item) => typeof item === "string")) return "unknown";
  return modalities.includes("image") ? "supported" : "unsupported";
}

/**
 * 从一条模型选择/请求头记录里取出可用的 provider/model 路由。
 *
 * 任何兼容读取都必须做结构校验：DSH 的 ModelSelection 是 `{provider, model,
 * reasoningEffort?}`，但这里的输入可能来自旧宿主、事件快照的冻结对象或测试替身，
 * 因此非对象、空串、非字符串一律视为"没有可用路由"，绝不猜测。
 * @param {unknown} value - 候选选择对象（ModelSelection 或 LlmCallConfig）。
 * @returns {{provider: string, model: string}|undefined} 归一后的路由，或 undefined。
 */
function modelRouteOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (provider.length === 0 || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * 判定"下一个请求将使用的模型路由"，解决切换模型后的能力时序问题。
 *
 * 背景：DSH 的 `session.requestHeader()` 返回**已发出请求**的历史配置。用户在 UI 里
 * 切换模型后立即发图时，新模型要等到下一次 prompt assembly 才生效，此时 requestHeader
 * 仍是旧模型——按旧模型能力路由会把图片错误地交给 Observer（或错误地留在主模型）。
 *
 * 公开 seam：`session.snapshotEvents()`（DSH Session 的公开方法）会按 seq 顺序给出事件；
 * `model/selection` 是"已校验、待生效"的用户选择，`request/header` 是"已发出请求"的快照。
 * 二者取**seq 更大**的那个即"下一个请求"的模型，无需复制 DSH 的完整 selection 状态机：
 * 从尾部向前找到第一条这两类事件即可（后写入的 seq 更大）。
 *
 * fail-safe：若最新的 `model/selection` 结构无效（既不是完整 provider/model，也无法证明
 * 与旧 header 一致），则返回 source="none" 且 staleHeaderIgnored=true —— 调用方必须
 * 放弃旧 header（那是被取代的模型），按 unknown 走保守的 main-first，而不是把旧能力
 * 当成新模型的能力。旧宿主没有 snapshotEvents 时退回 requestHeader 语义（保持可用）。
 *
 * @param {{events?: unknown, headerConfig?: unknown}} [evidence]
 *   events 为 `session.snapshotEvents()` 的返回值（可缺失）；headerConfig 为
 *   `session.requestHeader()?.config`（可缺失）。
 * @returns {{provider?: string, model?: string, source: "model-selection"|"request-header"|"none", staleHeaderIgnored: boolean}}
 *   能力判定必须使用的路由；source="none" 表示"无法确定下一个请求的模型"。
 */
export function effectiveModelRoute({ events, headerConfig } = {}) {
  const header = modelRouteOf(headerConfig);
  if (Array.isArray(events)) {
    // 反向扫描：第一条命中的事件就是两类事件里 seq 最大的那条。
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event === null || typeof event !== "object") continue;
      const type = event.type;
      if (type !== "model/selection" && type !== "request/header") continue;
      if (type === "model/selection") {
        const pending = modelRouteOf(event.data);
        if (pending === undefined) {
          // 用户确实切换过，但这条选择读不出 provider/model：旧 header 已被取代，
          // 不能继续用它做能力判定，也不能假装它是新模型。
          return { source: "none", staleHeaderIgnored: true };
        }
        return { ...pending, source: "model-selection", staleHeaderIgnored: false };
      }
      // 最新一条是 request/header：它重建出的就是当前请求头（与 fold 同源）。
      const logged = modelRouteOf(event.data?.header?.config);
      const route = logged ?? header;
      return route === undefined
        ? { source: "none", staleHeaderIgnored: false }
        : { ...route, source: "request-header", staleHeaderIgnored: false };
    }
  }
  // 旧宿主没有事件快照：保持既有 requestHeader 语义（不引入新的失败模式）。
  return header === undefined
    ? { source: "none", staleHeaderIgnored: false }
    : { ...header, source: "request-header", staleHeaderIgnored: false };
}

/**
 * 按产品规则作出不猜测的路由选择。unknown 绝不被偷偷视为 main 不支持；
 * Observer 优先时则必须先证明 Observer 支持 image，避免丢失用户输入。
 */
export function decideImageRoute({ mainImage, observerImage, observerPreferred }) {
  if (observerPreferred === true) {
    if (observerImage === "supported") return { target: "observer" };
    return { target: "error", code: "OBSERVER_IMAGE_UNSUPPORTED", message: "已开启 Observer优先，但 Observer 模型未明确支持 image；原始输入已保留。" };
  }
  if (mainImage !== "unsupported") return { target: "main" };
  if (observerImage === "supported") return { target: "observer" };
  return { target: "error", code: "OBSERVER_IMAGE_UNSUPPORTED", message: "主模型明确不支持 image，且 Observer 模型未明确支持 image；原始输入已保留。" };
}

/**
 * 构造传给任意专家 role 的原生 ContentBlock[]；图片本身必须已是 Host 创建的 PNG ref。
 * text 只在有实际内容时写入一次，attachments 可用于保持多图的输入顺序。
 * role 仅用于生成可诊断的边界错误，不参与图片数据处理。
 */
export function buildImageContent({ attachment, attachments, text, role = "专家" }) {
  const refs = Array.isArray(attachments) ? attachments : [attachment];
  const label = typeof role === "string" && role.trim().length > 0 ? role.trim() : "专家";
  if (refs.length === 0) throw new TypeError(`${label} 图片输入不能为空`);
  for (const ref of refs) {
    if (!ref || typeof ref !== "object"
      || ref.mediaType !== "image/png"
      || typeof ref.attachmentId !== "string"
      || ref.attachmentId.length === 0
      || Object.prototype.hasOwnProperty.call(ref, "pngPath")) {
      throw new TypeError(`${label} 只能接收 Host 创建的 image/png durable attachment，不能接收 pngPath`);
    }
  }
  return [
    ...(typeof text === "string" && text.trim().length > 0 ? [{ type: "text", text }] : []),
    ...refs.map((ref) => ({ type: "image", attachment: ref })),
  ];
}

/** 保留 Observer 的既有公开入口；实现已泛化到所有支持 image 的专家 role。 */
export function buildObserverImageContent({ attachment, attachments, text }) {
  return buildImageContent({ attachment, attachments, text, role: "Observer" });
}
