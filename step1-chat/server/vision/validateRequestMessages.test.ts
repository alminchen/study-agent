import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRequestMessages } from "./validateRequestMessages.js";

/** 1x1 透明 PNG 的 base64（不含 data: 前缀），与校验测试共用同一份图。 */
const VALID_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

const validAttachment = {
  id: "att_1",
  mimeType: "image/png",
  data: VALID_1X1_PNG_BASE64,
  name: "screenshot.png",
  width: 1,
  height: 1,
  byteSize: 68,
};

test("没有附件时原样放行", () => {
  const result = validateRequestMessages([
    { role: "user", content: "你好" },
    { role: "assistant", content: "嗨" },
  ]);
  assert.deepEqual(result, { ok: true });
});

test("非数组 / 非数组消息直接放行（不属于附件的错）", () => {
  assert.deepEqual(validateRequestMessages(undefined), { ok: true });
  assert.deepEqual(validateRequestMessages("not-an-array"), { ok: true });
});

test("合法 user 附件通过校验", () => {
  const result = validateRequestMessages([
    { role: "user", content: "这张图什么情况", attachments: [validAttachment] },
  ]);
  assert.deepEqual(result, { ok: true });
});

test("非 user 角色携带附件直接拒绝", () => {
  const result = validateRequestMessages([
    { role: "assistant", content: "hi", attachments: [validAttachment] },
  ]);
  assert.deepEqual(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "image_invalid_data");
    assert.match(result.reason, /user/);
  }
});

test("一次请求超过 1 张图直接拒绝", () => {
  const result = validateRequestMessages([
    { role: "user", content: "a", attachments: [validAttachment] },
    { role: "user", content: "b", attachments: [validAttachment] },
  ]);
  assert.deepEqual(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "image_invalid_data");
    assert.match(result.reason, /最多允许 1 张/);
  }
});

test("attachments 不是数组直接拒绝", () => {
  const result = validateRequestMessages([
    { role: "user", content: "a", attachments: "oops" },
  ]);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_invalid_data");
});

test("单张图片校验失败时透传具体错误码", () => {
  const result = validateRequestMessages([
    {
      role: "user",
      content: "a",
      attachments: [{ ...validAttachment, mimeType: "image/gif" }],
    },
  ]);
  assert.deepEqual(result.ok, false);
  if (!result.ok) assert.equal(result.code, "image_unsupported_format");
});
