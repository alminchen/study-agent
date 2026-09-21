/**
 * 读运行时配置。
 * mockMode = 强制 MOCK_MODE=1，或根本没有 LLM_API_KEY → 走假流式，不产生真实 usage。
 */
export function getRuntimeConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const forceMock = process.env.MOCK_MODE === "1";
  const mockMode = forceMock || !apiKey;
  return {
    apiKey,
    forceMock,
    mockMode,
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
  };
}
