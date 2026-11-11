/**
 * 路由层对整条请求的图片附件做二次硬校验（不信前端）。
 *
 * 规则：
 * - 只有 role === "user" 的消息允许携带 attachments，其他角色直接拒绝；
 * - 一次请求最多 MAX_IMAGES_PER_REQUEST 张图；
 * - 每张图再逐项过 validateImage（MIME / base64 / 像素 / 字节）。
 *
 * 校验失败返回 code + reason，调用方直接回 vision_rejected：
 * 不创建 UsageAccumulator、不调模型，省 token（决策三 / 6.2）。
 */
import type { ImageAttachment } from "../react/types.js";
import { MAX_IMAGES_PER_REQUEST, type VisionErrorCode } from "./types.js";
import { validateImage } from "./validateImage.js";

export type RequestAttachmentCheck =
  | { ok: true }
  | { ok: false; code: VisionErrorCode; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function validateRequestMessages(
  messages: unknown,
): RequestAttachmentCheck {
  if (!Array.isArray(messages)) return { ok: true };

  let imageCount = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const attachments = message.attachments;
    if (attachments === undefined || attachments === null) continue;

    if (!Array.isArray(attachments)) {
      return {
        ok: false,
        code: "image_invalid_data",
        reason: "attachments 必须是数组",
      };
    }
    if (message.role !== "user") {
      return {
        ok: false,
        code: "image_invalid_data",
        reason: "只有 user 消息允许携带附件",
      };
    }

    imageCount += attachments.length;
    if (imageCount > MAX_IMAGES_PER_REQUEST) {
      return {
        ok: false,
        code: "image_invalid_data",
        reason: `一次请求最多允许 ${MAX_IMAGES_PER_REQUEST} 张图片`,
      };
    }

    for (const attachment of attachments) {
      // wire 层字段与内部 ImageAttachment 同名同义；逐张过服务端硬校验。
      const result = validateImage(attachment as ImageAttachment);
      if (!result.ok) {
        return { ok: false, code: result.code, reason: result.message };
      }
    }
  }

  return { ok: true };
}
