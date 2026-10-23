/**
 * 组合根顶层的第 S3 段（R1 票据 06）：自 index.js 第 396–424 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

/**
 * sharp 是可选依赖（package.json optionalDependencies，约 30MB 原生二进制的 libvips 绑定）：
 * 默认安装不再强制下载；需要非 PNG 图片转码（如 JPEG/WebP/GIF 上传）的用户显式安装后自动启用。
 * 未安装时图像增强禁用，但降级必须是"明确失败且不伪造 PNG"，绝不静默把原字节改名成 .png。
 *
 * 该文案同时是 RPC 层识别能力缺失的依据（见 mapRpcError），因此抽成常量，避免两处文案漂移
 * 导致 503 image-transcoder-unavailable 退化成 500 internal。
 */
export const IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE = "当前 Host 没有可用的真实 PNG 转码器（sharp 为可选依赖，未安装时图像增强禁用，安装后自动启用）";

let sharpLoader;
export async function transcodeImageToPng(data) {
  if (sharpLoader === void 0) {
    sharpLoader = import("sharp").then((loaded) => loaded.default ?? loaded).catch((error) => {
      // 转码器缺失时清空 rejected Promise，允许安装/热载入后重试，并向 RPC 返回可理解的能力错误。
      // 并发语义：import 进行中的调用共享同一个在途 Promise（不会重复触发加载）；一旦失败就立刻
      // 清空缓存，使"安装 sharp 后无需重启"成立——下一次调用会重新 import，成功即恢复图像增强。
      sharpLoader = void 0;
      throw new Error(IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE, { cause: error });
    });
  }
  const sharp = await sharpLoader;
  try {
    return new Uint8Array(await sharp(data, { failOn: "error" }).png().toBuffer());
  } catch (error) {
    throw new Error("图片无法真实转换为 PNG", { cause: error });
  }
}

