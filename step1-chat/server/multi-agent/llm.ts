/**
 * 多 Agent 模块的公共 LLM 调用封装。
 *
 * 问题：supervisor、每个 Worker、aggregate 都需要调 LLM，
 * 每次都写一遍 fetch + headers + JSON.stringify + 错误处理，重复且容易出错。
 *
 * 解决：抽出 callLLM 方法，统一处理：
 * - 接口地址拼接和默认值
 * - 请求头（Content-Type + Authorization）
 * - JSON 序列化
 * - HTTP 错误判断
 * - 响应解析 + usage 统计
 *
 * 调用方只需关心：messages、tools（可选）、model（可选）。
 */

import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";

/** LLM 调用的通用参数 */
export interface CallLLMOptions {
  /** 消息列表（system + user + assistant + tool 等） */
  messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  /** API Key */
  apiKey: string;
  /** 接口地址，默认 DeepSeek */
  baseUrl?: string;
  /** 模型名，默认 deepseek-chat */
  model?: string;
  /** 工具 schema 列表（不传 = 不带工具） */
  tools?: unknown[];
  /** tool_choice，默认 "auto"（不传 tools 时忽略） */
  toolChoice?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 解析到 usage 时回调（Token 统计） */
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/** LLM 调用的响应（简化后的结构） */
export interface CallLLMResult {
  /** 是否成功（HTTP 2xx） */
  ok: boolean;
  /** HTTP 状态码（失败时用于调试） */
  status: number;
  /** 模型回复的 content（可能为 null，如纯 tool_calls 场景） */
  content: string | null;
  /** 模型返回的 tool_calls（没有则为空数组） */
  toolCalls: { id: string; function: { name: string; arguments: string } }[];
  /** 本次调用的 token 用量（可能为 null） */
  usage: TokenUsage | null;
}

export async function callLLM(options: CallLLMOptions): Promise<CallLLMResult> {
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1").replace(/\/$/, "");
  const model = options.model ?? process.env.LLM_MODEL ?? "deepseek-chat";

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    stream: false,
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    return { ok: false, status: response.status, content: null, toolCalls: [], usage: null };
  }

  const data = await response.json() as {
    choices: {
      message: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  };

  const usage = parseUsageFromResponse(data);
  if (usage) {
    options.onUsage?.(usage, model);
  }

  const msg = data.choices?.[0]?.message;
  return {
    ok: true,
    status: response.status,
    content: msg?.content ?? null,
    toolCalls: msg?.tool_calls ?? [],
    usage,
  };
}
