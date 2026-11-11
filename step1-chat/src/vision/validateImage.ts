/**
 * 前端图片快速校验（步骤 6）。
 *
 * 前端校验只是体验，最终合法性以服务端为准：
 * 这里的阈值与 server/vision/types.ts 保持一致，
 * 校验顺序也与 server/vision/validateImage.ts 对齐（data → MIME → 像素 → 字节）。
 */
import type { ChatAttachment, VisionErrorCode } from "../types";

/** 允许的图片 MIME；与 server/vision/types.ts 的 ALLOWED_IMAGE_MIME_TYPES 完全一致。 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** 图片解码后的字节上限（1MB），与服务端一致。 */
export const MAX_IMAGE_BYTES = 1 * 1024 * 1024;

/** 像素上限（4096 × 4096），与服务端一致。 */
export const MAX_IMAGE_DIMENSION = 4096;

/** 一次请求最多允许的图片张数；首版只做 1 张。 */
export const MAX_IMAGES_PER_REQUEST = 1;

/** 前端校验结果：ok 或带错误码的具体原因。 */
export type FrontendImageCheckResult =
  | { ok: true }
  | { ok: false; code: VisionErrorCode; reason: string };

/** MIME 白名单判断；代价极低，适合文件加入前的快速拦截。 */
export function isAllowedImageMime(mimeType: string): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * 对压缩产物的四项快速校验：
 * data 非空 → MIME 白名单 → 像素上限 → 字节上限。
 */
export function validateImage(attachment: ChatAttachment): FrontendImageCheckResult {
  if (!attachment.data) {
    return { ok: false, code: "image_invalid_data", reason: "图片数据为空" };
  }
  if (!isAllowedImageMime(attachment.mimeType)) {
    return {
      ok: false,
      code: "image_unsupported_format",
      reason: `不支持的图片格式：${attachment.mimeType}（仅支持 png/jpeg/webp）`,
    };
  }
  if (
    attachment.width > MAX_IMAGE_DIMENSION ||
    attachment.height > MAX_IMAGE_DIMENSION
  ) {
    return {
      ok: false,
      code: "image_dimensions_exceeded",
      reason: `图片尺寸超限（上限 ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}）`,
    };
  }
  if (attachment.byteSize > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: "image_too_large",
      reason: `图片超过 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB 上限`,
    };
  }
  return { ok: true };
}
