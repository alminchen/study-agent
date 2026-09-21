import { toolSchemasForChat } from "../tools/index.js";
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import type { ProviderChoice, ProviderMessage, ReactLoopOptions } from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

export interface CompletionResult {
  choice: ProviderChoice;
  usage: TokenUsage | null;
}

/**
 * 带 tools 问一次模型（非流式）。
 *
 * messages 里若含带 tool_calls 的 assistant，须保留 reasoning_content（思考模式）。
 * 不传 tool_choice 指定函数名：DeepSeek 思考模式不支持。
 */
export async function requestCompletion(
  messages: ProviderMessage[],
  options: ReactLoopOptions,
  apiKey: string,
): Promise<CompletionResult> {
  const includeSearchDocs = Boolean(options.searchDocs);
  const includeConfirmTools = Boolean(options.confirmSession);
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? process.env.LLM_MODEL ?? "deepseek-chat";
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: toolSchemasForChat(includeSearchDocs, includeConfirmTools),
      tool_choice: "auto",
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    const status = response.status;
    if (status === 400) {
      throw new Error(`模型请求参数错误，请检查消息格式或联系开发者（400）${raw ? `：${raw.slice(0, 150)}` : ""}`);
    }
    if (status === 401 || status === 403) {
      throw new Error("API Key 无效或已过期，请检查配置");
    }
    if (status === 429) {
      throw new Error("请求过于频繁，请稍后再试");
    }
    if (status >= 500) {
      throw new Error("模型服务暂时不可用，请稍后重试");
    }
    throw new Error(`LLM 请求失败 (${status})${raw ? `：${raw.slice(0, 150)}` : ""}`);
  }

  const data = JSON.parse(raw) as { choices?: ProviderChoice[] };
  const usage = parseUsageFromResponse(data);
  if (usage) {
    options.onUsage?.(usage, model);
  }
  return {
    choice: data.choices?.[0] ?? {},
    usage,
  };
}
