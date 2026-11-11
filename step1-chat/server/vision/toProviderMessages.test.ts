import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderMessage, TextMessage } from "../react/types.js";
import { toProviderMessages } from "./toProviderMessages.js";

/** 1x1 透明 PNG 的 base64（不含 data: 前缀），与校验测试共用同一份图。 */
const VALID_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";

function userMessage(overrides: Partial<TextMessage> = {}): TextMessage {
  return {
    role: "user",
    content: "这张截图里有什么问题？",
    ...overrides,
  };
}

test("带图 user 消息转成 text + image_url 两个 parts，文字在前图片在后", () => {
  const message = userMessage({
    attachments: [
      {
        id: "att_1",
        mimeType: "image/png",
        data: VALID_1X1_PNG_BASE64,
        name: "screenshot.png",
        width: 1,
        height: 1,
        byteSize: 68,
      },
    ],
  });
  const [converted] = toProviderMessages([message]);
  assert.deepEqual(converted, {
    role: "user",
    content: [
      { type: "text", text: "这张截图里有什么问题？" },
      {
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${VALID_1X1_PNG_BASE64}`,
        },
      },
    ],
  });
});

test("不带图的 user 消息保持原字符串 content", () => {
  const plain = userMessage({ content: "你好，介绍一下自己" });
  const [converted] = toProviderMessages([plain]);
  assert.equal(converted, plain);
  assert.deepEqual(converted, plain);
});

test("assistant 带 tool_calls 的消息原样透传，不引入 parts", () => {
  const assistant: ProviderMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "getWeather", arguments: '{"city":"广州"}' },
      },
    ],
    reasoning_content: "用户想查广州天气",
  };
  const [converted] = toProviderMessages([assistant]);
  assert.equal(converted, assistant);
  assert.deepEqual(converted, assistant);
});

test("tool 消息原样透传，不受影响", () => {
  const tool: ProviderMessage = {
    role: "tool",
    tool_call_id: "call_1",
    content: '{"city":"广州","weather":"晴","temperature":26}',
  };
  const [converted] = toProviderMessages([tool]);
  assert.equal(converted, tool);
  assert.deepEqual(converted, tool);
});
