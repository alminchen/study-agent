import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
} from "./types.js";
import { validateImage } from "./validateImage.js";

/** 1x1 透明 PNG 的 base64（不含 data: 前缀）。 */
const VALID_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

function validAttachment(overrides: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    mimeType: "image/png",
    data: VALID_1X1_PNG_BASE64,
    name: "screenshot.png",
    width: 1,
    height: 1,
    byteSize: 68,
    ...overrides,
  };
}

test("允许的 MIME 集合只含 png/jpeg/webp", () => {
  assert.deepEqual(ALLOWED_IMAGE_MIME_TYPES, [
    "image/png",
    "image/jpeg",
    "image/webp",
  ]);
});

test("拒绝非法 MIME 类型", () => {
  const result = validateImage(validAttachment({ mimeType: "image/gif" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_unsupported_format");
});

test("拒绝超过大小上限的图片", () => {
  const result = validateImage(
    validAttachment({ byteSize: MAX_IMAGE_BYTES + 1 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_too_large");
});

test("拒绝非法 base64 内容", () => {
  const result = validateImage(
    validAttachment({ data: "not-valid-base64@@@" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_invalid_data");
});

test("拒绝像素超限的图片", () => {
  const result = validateImage(
    validAttachment({
      width: MAX_IMAGE_DIMENSION + 1,
      height: MAX_IMAGE_DIMENSION + 1,
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_dimensions_exceeded");
});

test("合法图片通过校验", () => {
  const result = validateImage(validAttachment());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.attachment.mimeType, "image/png");
    assert.equal(result.attachment.byteSize, 68);
  }
});

test("拒绝缺少必需字段的图片", () => {
  const result = validateImage(
    validAttachment({ data: undefined, width: undefined }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_invalid_data");
});

