/**
 * 供应商 content parts 协议转换（唯一转换入口，禁止各调用点自己拼）。
 *
 * 只有「user 消息且带附件」才拼成 content parts 数组：
 * 文字在前、图片在后（首版固定顺序），图片走 data URL。
 * 其余消息（system / 纯文本 user / assistant(tool_calls) / tool）逐条原样透传，
 * 行为与「不带图片」的今天完全一致。
 */
import type { ProviderMessage, TextMessage } from "../react/types.js";

/** OpenAI 兼容的 content part：文本或图片。 */
export interface ProviderContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/** user 带图消息转换后的供应商形状：content 是 parts 数组。 */
export type UserImageMessage = {
  role: "user";
  content: ProviderContentPart[];
};

function toContentParts(message: TextMessage): ProviderContentPart[] {
  const parts: ProviderContentPart[] = [{ type: "text", text: message.content }];
  for (const attachment of message.attachments ?? []) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.data}`,
      },
    });
  }
  return parts;
}

export function toProviderMessages(
  messages: readonly ProviderMessage[],
): Array<ProviderMessage | UserImageMessage> {
  return messages.map((message): ProviderMessage | UserImageMessage => {
    if (
      message.role === "user" &&
      Array.isArray(message.attachments) &&
      message.attachments.length > 0
    ) {
      // role === "user" 收窄后只剩 TextMessage，附件字段必然可访问。
      return { role: "user", content: toContentParts(message) };
    }
    return message;
  });
}
