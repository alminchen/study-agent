/**
 * 读运行时配置。
 * mockMode = 强制 MOCK_MODE=1，或根本没有 LLM_API_KEY → 走假流式，不产生真实 usage。
 */
import {
  DEFAULT_BUDGET_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "./context/tokenBudget.js";

/** 读取可关闭的超时配置；0 表示关闭，非法或负数回退到默认值。 */
function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 读取 0~1 之间的小数比例；非法值回退到默认值。 */
function readRatio(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) return fallback;
  return value;
}

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
    // 长上下文管理：注入预算 = 窗口 × 比例。
    // 窗口取模型官方上限的保守值，比例宁小勿大（剩下的留给输出和模型自身余量）。
    context: {
      windowTokens: readNonNegativeInt(
        "LLM_CONTEXT_WINDOW_TOKENS",
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      ),
      budgetRatio: readRatio(
        "LLM_CONTEXT_BUDGET_RATIO",
        DEFAULT_BUDGET_RATIO,
      ),
    },
    // 结构化端点单独持有能力开关和超时，避免影响普通聊天/RAG 的请求行为。
    structuredRequest: {
      // 默认请求 provider 的 JSON mode；设置为 "0" 可强制走纯 prompt 约束。
      jsonMode: process.env.LLM_STRUCTURED_JSON_MODE !== "0",
      // 默认请求流末尾 usage；部分兼容供应商不支持 stream_options 时可关闭。
      includeUsage: process.env.LLM_STRUCTURED_INCLUDE_USAGE !== "0",
      timeouts: {
        // 建立连接、等待首内容 chunk、整次结构化流分别限时。
        connectMs: readNonNegativeInt(
          "LLM_STRUCTURED_CONNECT_TIMEOUT_MS",
          15_000,
        ),
        firstChunkMs: readNonNegativeInt(
          "LLM_STRUCTURED_FIRST_CHUNK_TIMEOUT_MS",
          30_000,
        ),
        totalMs: readNonNegativeInt(
          "LLM_STRUCTURED_TOTAL_TIMEOUT_MS",
          180_000,
        ),
      },
    },
  };
}
