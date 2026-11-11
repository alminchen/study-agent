/**
 * 服务端图片校验。
 *
 * 前端校验只是体验，服务端才是不信任何输入的地方：
 * 按 字段存在 → MIME 白名单 → base64 合法 → 像素上限 → 字节上限 的顺序
 * 逐层拒绝；非法图片直接回 vision_rejected，不进入模型请求。
 */
import type { ImageAttachment } from "../react/types.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  type AllowedImageMimeType,
  type ValidateImageResult,
  type ValidatedImageAttachment,
} from "./types.js";

/** OpenAI 兼容的 base64：整组 4 字符 + 可选的 0~2 个 = 填充符。 */
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const ALLOWED_MIME = ALLOWED_IMAGE_MIME_TYPES as readonly string[];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateImage(
  attachment: ImageAttachment,
): ValidateImageResult {
  // 1. 必需字段齐全（缺失 / 类型错误一律按 invalid_data 拒绝）
  if (
    !isNonEmptyString(attachment.data) ||
    !isNonEmptyString(attachment.mimeType) ||
    !isPositiveNumber(attachment.width) ||
    !isPositiveNumber(attachment.height) ||
    !isPositiveNumber(attachment.byteSize)
  ) {
    return {
      ok: false,
      code: "image_invalid_data",
      message: "图片附件缺少必需字段（data/mimeType/width/height/byteSize）",
    };
  }

  // 2. MIME 白名单：png / jpeg / webp
  if (!ALLOWED_MIME.includes(attachment.mimeType)) {
    return {
      ok: false,
      code: "image_unsupported_format",
      message: `不支持的图片格式：${attachment.mimeType}`,
    };
  }

  // 3. base64 合法 + 解码非空
  if (!BASE64_PATTERN.test(attachment.data)) {
    return {
      ok: false,
      code: "image_invalid_data",
      message: "图片 base64 数据非法",
    };
  }
  const decodedBytes = Buffer.from(attachment.data, "base64").length;
  if (!Number.isInteger(decodedBytes) || decodedBytes <= 0) {
    return {
      ok: false,
      code: "image_invalid_data",
      message: "图片 base64 解码后为空",
    };
  }

  // 4. 像素上限
  if (
    attachment.width > MAX_IMAGE_DIMENSION ||
    attachment.height > MAX_IMAGE_DIMENSION
  ) {
    return {
      ok: false,
      code: "image_dimensions_exceeded",
      message: `图片尺寸超限（上限 ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}）`,
    };
  }

  // 5. 字节上限：上报值与解码值都不得超过 1MB
  if (attachment.byteSize > MAX_IMAGE_BYTES || decodedBytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      code: "image_too_large",
      message: `图片超过 ${MAX_IMAGE_BYTES / (1024 * 1024)}MB 上限`,
    };
  }

  const validated: ValidatedImageAttachment = {
    id: attachment.id,
    mimeType: attachment.mimeType as AllowedImageMimeType,
    data: attachment.data,
    name: attachment.name,
    width: attachment.width,
    height: attachment.height,
    byteSize: attachment.byteSize,
  };
  return { ok: true, attachment: validated };
}
