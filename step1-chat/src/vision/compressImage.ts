/**
 * 前端图片压缩（步骤 6）：canvas 降采样 + 编码压缩。
 *
 * 流程：
 * 1. decode 源图（createImageBitmap，旧浏览器回退到 <img> + objectURL）
 * 2. 最长边 1600px 降采样
 * 3. 有透明通道 → webp（不支持时 png，保留透明）；否则 jpeg 0.85
 * 4. 压缩后仍超 1MB → 最长边降到 1200px 重压一次；仍超则拒绝
 * 5. 返回 ChatAttachment：data 是 base64 裸串（不含 data: 前缀），
 *    previewUrl 是 objectURL（仅内存，不持久化）
 */
import type { ChatAttachment, VisionErrorCode } from "../types";
import {
  MAX_IMAGE_BYTES,
  validateImage,
} from "./validateImage";

/** 首轮压缩的最长边：上传体积的体验上限。 */
const COMPRESS_MAX_LONG_EDGE = 1600;
/** 超限重试轮的最长边：再压不进来就该拒绝，而不是无限压下去。 */
const COMPRESS_RETRY_LONG_EDGE = 1200;
/** JPEG 压缩质量；与计划文档决策三的 0.85 一致。 */
const JPEG_QUALITY = 0.85;

/** 解码后的画布来源；统一 dispose，避免 ImageBitmap / <img> 两条路径泄漏。 */
interface DecodedSource {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
}

export type CompressImageResult =
  | { ok: true; attachment: ChatAttachment }
  | { ok: false; code: VisionErrorCode; reason: string };

let attachmentCounter = 0;

function createAttachmentId(): string {
  return `att_${Date.now()}_${attachmentCounter++}`;
}

async function decodeSource(file: File): Promise<DecodedSource> {
  // createImageBitmap 可以直接吃 File/Blob，且原样支持宽高读取。
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }
  // 旧浏览器回退：objectURL + <img>，dispose 时 revoke。
  return await new Promise<DecodedSource>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        dispose: () => URL.revokeObjectURL(url),
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败"));
    };
    image.src = url;
  });
}

/** 检测绘制结果是否含透明像素，决定用什么编码保留透明。 */
function hasTransparentPixels(canvas: HTMLCanvasElement): boolean {
  try {
    const context = canvas.getContext("2d");
    if (!context) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) return true;
    }
    return false;
  } catch {
    // 拿不到像素数据的场景按不透明处理，不让整张图被拒。
    return false;
  }
}

/** 检测 canvas 是否支持 webp 编码；不支持时透明图退回 png。 */
function supportsWebp(canvas: HTMLCanvasElement): boolean {
  try {
    return canvas.toDataURL("image/webp").startsWith("data:image/webp");
  } catch {
    return false;
  }
}

function encodeBlob(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error(`图片编码失败：${mimeType}`)),
      mimeType,
      JPEG_QUALITY,
    );
  });
}

/** 编码一次：先决定 MIME（透明 → webp/png；否则 jpeg），再输出 blob。 */
async function encodeOnce(
  canvas: HTMLCanvasElement,
): Promise<{ mimeType: string; blob: Blob }> {
  const transparent = hasTransparentPixels(canvas);
  const mimeType = transparent
    ? supportsWebp(canvas)
      ? "image/webp"
      : "image/png"
    : "image/jpeg";
  const blob = await encodeBlob(canvas, mimeType);
  return { mimeType, blob };
}

/** 计算降采样尺寸：保持宽高比，长边封顶到 maxLongEdge。 */
function scaledSize(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function drawToCanvas(
  source: DecodedSource,
  maxLongEdge: number,
): HTMLCanvasElement {
  const size = scaledSize(source.width, source.height, maxLongEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");
  context.drawImage(source.source, 0, 0, size.width, size.height);
  return canvas;
}

/** blob → base64 裸串（去掉 data: 前缀；与服务端 wire 协议一致）。 */
function blobToBase64Data(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 压缩一张图片为待发附件。
 *
 * 解码失败返回 image_invalid_data；压两轮仍超 1MB 返回 image_too_large。
 * 成功后 base64 已就绪，发送接线（步骤 7）直接消费 attachment.data。
 */
export async function compressImage(file: File): Promise<CompressImageResult> {
  let source: DecodedSource;
  try {
    source = await decodeSource(file);
  } catch {
    return { ok: false, code: "image_invalid_data", reason: "图片无法解码，请换一张再试" };
  }
  try {
    let canvas = drawToCanvas(source, COMPRESS_MAX_LONG_EDGE);
    let { mimeType, blob } = await encodeOnce(canvas);
    if (blob.size > MAX_IMAGE_BYTES) {
      canvas = drawToCanvas(source, COMPRESS_RETRY_LONG_EDGE);
      ({ mimeType, blob } = await encodeOnce(canvas));
    }
    if (blob.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        code: "image_too_large",
        reason: "图片压缩后仍超过 1MB 上限",
      };
    }
    const attachment: ChatAttachment = {
      id: createAttachmentId(),
      name: file.name || "粘贴图片",
      mimeType,
      width: canvas.width,
      height: canvas.height,
      byteSize: blob.size,
      data: await blobToBase64Data(blob),
      previewUrl: URL.createObjectURL(blob),
    };
    const check = validateImage(attachment);
    if (!check.ok) {
      return { ok: false, code: check.code, reason: check.reason };
    }
    return { ok: true, attachment };
  } finally {
    source.dispose();
  }
}
