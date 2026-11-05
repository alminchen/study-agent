import { toolSchemasForChat } from "../tools/index.js";
import type { ToolSchema } from "../tools/types.js";
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import type { ProviderChoice, ProviderMessage, ReactLoopOptions } from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

export interface CompletionResult {
  choice: ProviderChoice;
  usage: TokenUsage | null;
}

export interface RequestCompletionExtras {
  /**
   * 是否关闭思考模式（工具轮建议关，降延迟）。
   * 代理若不支持 `thinking` 字段，可能 400；可用 LLM_TOOL_TURN_THINKING=keep 关掉本逻辑。
   */
  disableThinking?: boolean;
  /**
   * 覆盖默认工具列表。
   * ReAct 走聊天工具；Planner 走 emit_plan 独占工具（不挂任何业务工具）。
   * 不传时行为与之前完全一致。
   */
  tools?: ToolSchema[];
}

/** 工具轮默认关 thinking；设为 keep 则不传 thinking 字段（兼容旧代理）。 */
function shouldDisableThinking(explicit?: boolean): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  const flag = (process.env.LLM_TOOL_TURN_THINKING ?? "disabled").trim().toLowerCase();
  return flag !== "keep" && flag !== "on" && flag !== "enabled";
}

/**
 * 带 tools 问一次模型（非流式）。
 *
 * ## post-learning 语义 C
 * `/api/chat` 勾选「搜索知识库」只触发 prefetch，**不再**把 searchDocs 挂给模型。
 * 本函数固定 `includeSearchDocs=false`；天气/时间/确认类工具照常。
 *
 * messages 里若含带 tool_calls 的 assistant，须保留 reasoning_content（思考模式）。
 * 不传 tool_choice 指定函数名：DeepSeek 思考模式不支持。
 */
export async function requestCompletion(
  messages: ProviderMessage[],
  options: ReactLoopOptions,
  apiKey: string,
  extras?: RequestCompletionExtras,
): Promise<CompletionResult> {
  // 语义 C：ReAct 永不挂 searchDocs（检索由 prefetch 完成）
  const includeSearchDocs = false;
  const includeConfirmTools = Boolean(options.confirmSession);
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model ?? process.env.LLM_MODEL ?? "deepseek-chat";

  const body: Record<string, unknown> = {
    model,
    messages,
    tools: extras?.tools ?? toolSchemasForChat(includeSearchDocs, includeConfirmTools),
    tool_choice: "auto",
    stream: false,
  };

  // P0：工具轮关 thinking，缩短「第一次 askModel」墙钟
  if (shouldDisableThinking(extras?.disableThinking)) {
    body.thinking = { type: "disabled" };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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
