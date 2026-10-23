/**
 * 入口图片上传归一（R4e · 票据 19）。
 *
 * 客户端草稿图片在 **任何能力决策之前** 统一落成 Host-owned PNG durable ref：
 * 先做严格 wire 校验与字节级转码，再按公开 attachments.saveImage 顺序创建副本；
 * 输出同时保留真实 PNG 字节（供主代理走原生 prompt 的 encoded image）与 durable ref
 * （Observer 只接收这个新 ref）。因此「拒绝路由 / 切换到 Observer / 主模型不支持图片」
 * 都不会让识别输入绕过 PNG 边界。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册、不持状态：附件服务的绑定仍在 `index.js` 的
 * `ctx.inject(["attachments"], ...)`。这里只接收一个取值函数（晚绑定，与迁移前同一语义）。
 *
 * ## 行为等价
 * 数量预算（1..16）、attachmentStore 缺失时的 400、逐项 abort 检查、
 * "先全部转码、再全部落盘"的两阶段顺序、以及 durable ref 形状校验后的错误文案
 * 全部保持不变（错误仍是 ValidationError → 400 invalid-selection）。
 *
 * @module dsh-expert-group/host/index-upload-normalize
 */
/**
 * 创建上传归一能力面。
 *
 * @param {object} deps - 窄能力面（6 组）。
 * @param {Function} deps.ValidationError - 入口声明的校验错误类（类身份唯一）。
 * @param {object} deps.attachmentAccess - 附件服务读面：`getStore()` 返回当前绑定或 undefined
 *   （命名不同于函数内的 `attachments` 局部数组，避免 TDZ 遮蔽）。
 * @param {object} deps.wire - 图片 wire 校验面：`validateEncodedImageInput(input)`（
 *   host/index-image-route.js 提供，使用同一个 ValidationError 类身份）。
 * @param {object} deps.imagePipeline - 图片管线：`toPngBytes`、`pngCopyName`、
 *   `transcodeImageToPng`（真实转码实现，缺失即抛固定不可用消息）。
 * @param {object} deps.abort - 取消面：`createAbortError()`。
 * @param {{maxCount: number}} deps.limits - 单次请求的图片数量预算。
 * @returns {{normalizeUploadedImages: (images: Array, signal: AbortSignal|undefined) => Promise<Array>}}
 */
export function createUploadNormalizer({ ValidationError, attachmentAccess, wire, imagePipeline, abort, limits }) {
  /**
   * 客户端草稿图片先在 Host 侧统一落成 PNG durable ref。输出同时保留真实 PNG
   * 字节，供主代理走原生 prompt 的 encoded image；Observer 只接收这个新 ref。
   * 此函数在任何能力决策前执行，保证拒绝/切换路由也不会让识别输入绕过 PNG 边界。
   */
  async function normalizeUploadedImages(images, signal) {
    if (!Array.isArray(images) || images.length === 0 || images.length > limits.maxCount) {
      throw new ValidationError("图片数量必须在 1-" + limits.maxCount + " 张之间");
    }
    if (attachmentAccess.getStore() === void 0 || typeof attachmentAccess.getStore().saveImage !== "function") {
      throw new ValidationError("当前 Host 未挂载公开附件服务，无法创建 PNG 副本");
    }
    // 先完成全部字节级校验/转码，再按公开 saveImage API 顺序创建副本；能力查询始终在此之后。
    const prepared = [];
    for (const rawInput of images) {
      if (signal?.aborted === true) throw abort.createAbortError();
      const input = wire.validateEncodedImageInput(rawInput);
      const png = await imagePipeline.toPngBytes({
        mediaType: input.mediaType,
        data: input.data,
        transcodeToPng: (source) => imagePipeline.transcodeImageToPng(source),
      });
      prepared.push({ data: png, mediaType: "image/png", name: imagePipeline.pngCopyName(input.name) });
    }
    const attachments = [];
    for (const input of prepared) {
      if (signal?.aborted === true) throw abort.createAbortError();
      attachments.push(await attachmentAccess.getStore().saveImage(input));
    }
    return prepared.map((input, index) => {
      const attachment = attachments[index];
      if (!attachment || typeof attachment !== "object"
        || attachment.mediaType !== "image/png"
        || typeof attachment.attachmentId !== "string"
        || attachment.attachmentId.length === 0) {
        throw new Error("附件服务没有返回有效的 image/png durable reference");
      }
      return {
        attachment,
        data: Buffer.from(input.data).toString("base64"),
        mediaType: "image/png",
        name: typeof attachment.name === "string" && attachment.name.length > 0
          ? attachment.name
          : input.name,
      };
    });
  }

  return { normalizeUploadedImages };
}
