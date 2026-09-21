import type { TextMessage } from "../react/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按字切成小段，配合 sleep 模拟打字效果。 */
function splitReply(reply: string, size: number) {
  const chars = Array.from(reply);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

/**
 * 无 API Key / MOCK_MODE 时的假流式回复。
 * 不调模型、不调工具，只走 onDelta，方便前端先把 SSE 链路跑通。
 */
export async function streamMock(options: {
  messages: TextMessage[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}) {
  const lastUser = [...options.messages].reverse().find((message) => message.role === "user");
  const prompt = lastUser?.content.trim() || "你好";
  const reply = `你好！你刚才说的是：“${prompt}”。当前处于 Mock 模式：请求已经走了完整的 fetch + ReadableStream 链路，只是回复由本地模拟生成。配置 LLM_API_KEY 后即可切换到真实模型。`;

  for (const chunk of splitReply(reply, 4)) {
    if (options.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    options.onDelta(chunk);
    await sleep(24);
  }
}
