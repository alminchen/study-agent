import type { RagMessage } from "./prompt.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/**
 * 把已经拼好的 RAG messages 发给聊天模型，拿一段完整回复。
 * 不带 tools，也不走 createChatStream（那边会换掉 RAG system、并挂天气工具）。
 */
export async function completeRagMessages(
  messages: RagMessage[],
  signal?: AbortSignal,
  model?: string,
): Promise<string> {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    throw new Error(
      "RAG 问答需要真实 LLM。请在 .env 配置 LLM_API_KEY，且不要设 MOCK_MODE=1。",
    );
  }
  const baseUrl = (process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || process.env.LLM_MODEL || "deepseek-chat",
      messages,
      stream: false,
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM 请求失败 (${response.status})${raw ? `: ${raw.slice(0, 200)}` : ""}`);
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}
