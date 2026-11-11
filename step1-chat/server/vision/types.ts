/**
 * Vision（图片输入）共享类型与限制常量。
 *
 * 命名约定：字段必须与前端 src/types.ts 同名同义，否则跨端契约会静默丢数据。
 * 本文件是服务端侧的唯一契约来源；前端按逐字对齐维护一份镜像类型。
 */

/** 允许的图片 MIME；与浏览器端、服务端校验共用同一组值。 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** 单张图片解码后的字节上限（1MB）。 */
export const MAX_IMAGE_BYTES = 1 * 1024 * 1024;

/** 单张图片的像素上限（4096 × 4096）。 */
export const MAX_IMAGE_DIMENSION = 4096;

/** 一次请求最多允许的图片张数。首版只做 1 张，多图留到后续。 */
export const MAX_IMAGES_PER_REQUEST = 1;

/**
 * 服务端图片校验失败码。
 * 前端据 code 映射文案；code 与 message 都由服务端定死，前端不重写。
 */
export type VisionErrorCode =
  | "image_too_large"
  | "image_unsupported_format"
  | "image_invalid_data"
  | "image_dimensions_exceeded"
  | "vision_model_unsupported"
  | "vision_payload_too_large"
  | "vision_provider_rejected";

/** 服务端校验的返回：合法返回 data，非法返回 error。 */
export type ValidateImageResult =
  | { ok: true; attachment: ValidatedImageAttachment }
  | { ok: false; code: VisionErrorCode; message: string };

/** 通过校验、可以安全转交给供应商适配层的图片。 */
export interface ValidatedImageAttachment {
  id: string;
  mimeType: AllowedImageMimeType;
  /** base64 裸串，不含 data: 前缀；由适配层拼 data URL。 */
  data: string;
  name: string;
  width: number;
  height: number;
  byteSize: number;
}

/** 过程面板 / trace 事件：本轮带了几张图（不含 base64、不含文件名）。 */
export interface VisionAttachmentTraceEvent {
  type: "vision_attachment";
  count: number;
  mimeTypes: AllowedImageMimeType[];
  totalBytes: number;
  estimatedImageTokens: number;
}

/** 过程面板 / trace 事件：图片被拒，给具体原因。 */
export interface VisionRejectedTraceEvent {
  type: "vision_rejected";
  code: VisionErrorCode;
  reason: string;
}

/** 过程面板 / trace 事件：当前模型不支持 Vision。 */
export interface VisionUnsupportedModelTraceEvent {
  type: "vision_unsupported_model";
  model: string;
}

export type VisionTraceEvent =
  | VisionAttachmentTraceEvent
  | VisionRejectedTraceEvent
  | VisionUnsupportedModelTraceEvent;

