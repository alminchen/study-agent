/**
 * 从 chat/completions 响应 JSON 解析 usage 字段。
 *
 * OpenAI 兼容接口在非流式响应里通常返回：
 *   { choices: [...], usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * 调用方：
 *   - server/react/complete.ts      （单 Agent askModel）
 *   - server/multi-agent/llm.ts     （Supervisor / Worker / Aggregate）
 *   - server/rag/complete.ts        （资料问答）
 *
 * 注意：
 *   - 流式 stream: true 通常无完整 usage，本模块不处理流式场景
 *   - Mock 模式或无 usage 时返回 null，调用方跳过 record
 */

import type { TokenUsage } from "./types.js";

/**
 * 从 chat/completions 响应体提取 usage。
 *
 * @param data - fetch 后 JSON.parse 的完整响应对象
 * @returns 规范化后的 TokenUsage；缺失或全 0 时返回 null
 */
export function parseUsageFromResponse(data: unknown): TokenUsage | null {
  if (!data || typeof data !== "object") return null;

  const usage = (data as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;

  // API 字段名是 snake_case，转成项目内的 camelCase
  const row = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };

  const promptTokens = Number(row.prompt_tokens ?? 0);
  const completionTokens = Number(row.completion_tokens ?? 0);
  // 部分平台不返回 total_tokens，自行相加
  const totalTokens = Number(row.total_tokens ?? promptTokens + completionTokens);

  // 全 0 视为无效（Mock 或异常响应）
  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0) return null;

  return { promptTokens, completionTokens, totalTokens };
}
