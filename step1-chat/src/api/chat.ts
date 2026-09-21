import type { ChatRole, ToolTraceStep, UsageSnapshot } from "../types";

export interface StreamChatParams {
  messages: Array<{ role: ChatRole; content: string }>;
  model: string;
  signal: AbortSignal;
  /** 打开后服务端先强制检索，并把 searchDocs 交给模型（单 Agent 语义）。 */
  searchDocs?: boolean;
  /**
   * 是否走多 Agent。
   * true → POST /api/chat/multi；false → POST /api/chat。
   * 与 searchDocs 无关，由调用方显式传入。
   */
  multiAgent?: boolean;
  onDelta: (delta: string) => void;
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  onError: (error: string) => void;
}

export interface HealthInfo {
  mode: "mock" | "api";
  model: string;
}

export interface ConfirmChatParams {
  confirmId: string;
  toolCallId: string;
  action: "allow" | "deny";
}

/**
 * 人工确认放行/拒绝。
 * 只通知服务端 resolve(wait)；不负责执行工具或拉新回复。
 * 单 Agent（/api/chat）与多 Agent（/api/chat/multi）共用本接口。
 */
export async function confirmChatTool(params: ConfirmChatParams): Promise<void> {
  const response = await fetch("/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `确认失败：${response.status}`);
  }
}

/**
 * 普通对话流式聊天。
 * endpoint 由 multiAgent 决定；searchDocs 只进请求体，不参与选路。
 */
export async function streamChat({
  messages,
  model,
  signal,
  searchDocs,
  multiAgent = true,
  onDelta,
  onTrace,
  onUsage,
  onError,
}: StreamChatParams): Promise<boolean> {
  const endpoint = multiAgent ? "/api/chat/multi" : "/api/chat";
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model, searchDocs: Boolean(searchDocs) }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "网络请求失败");
    return false;
  }

  if (!response.ok) {
    onError(`服务异常：${response.status}`);
    return false;
  }
  if (!response.body) {
    onError("当前浏览器不支持流式响应");
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return true;
          try {
            const event = JSON.parse(payload) as {
              delta?: string;
              error?: string;
              type?: string;
              name?: string;
              arguments?: unknown;
              result?: unknown;
              confirmId?: string;
              toolCallId?: string;
              action?: "allow" | "deny";
              level?: string;
              rules?: string[];
              matchedFingerprints?: string[];
              totalTokens?: number;
              promptTokens?: number;
              completionTokens?: number;
              llmCalls?: number;
              estimatedCostUsd?: number;
              model?: string;
              endpoint?: UsageSnapshot["endpoint"];
            };
            if (event.error) {
              onError(event.error);
              return true;
            }
            if (event.type === "usage" && typeof event.totalTokens === "number") {
              onUsage?.({
                endpoint: event.endpoint,
                model: event.model ?? model,
                promptTokens: event.promptTokens ?? 0,
                completionTokens: event.completionTokens ?? 0,
                totalTokens: event.totalTokens,
                llmCalls: event.llmCalls ?? 1,
                estimatedCostUsd: event.estimatedCostUsd ?? 0,
              });
            }
            if (event.type === "tool_call" && event.name) {
              onTrace?.({ kind: "tool_call", name: event.name, arguments: event.arguments });
            }
            if (event.type === "tool_result" && event.name) {
              onTrace?.({ kind: "tool_result", name: event.name, result: event.result });
            }
            if (event.type === "injection_detected") {
              onTrace?.({
                kind: "injection_detected",
                level: event.level,
                rules: Array.isArray(event.rules) ? event.rules : [],
              });
            }
            if (event.type === "output_leak_blocked") {
              onTrace?.({
                kind: "output_leak_blocked",
                matchedFingerprints: Array.isArray(event.matchedFingerprints)
                  ? event.matchedFingerprints
                  : [],
              });
            }
            if (
              event.type === "pending_confirm" &&
              event.name &&
              event.confirmId &&
              event.toolCallId
            ) {
              onTrace?.({
                kind: "pending_confirm",
                confirmId: event.confirmId,
                toolCallId: event.toolCallId,
                name: event.name,
                arguments: event.arguments,
                status: "pending",
              });
            }
            if (
              event.type === "confirm_resolved" &&
              event.toolCallId &&
              (event.action === "allow" || event.action === "deny")
            ) {
              onTrace?.({
                kind: "confirm_resolved",
                toolCallId: event.toolCallId,
                name: event.name ?? "",
                action: event.action,
              });
            }
            if (event.delta) onDelta(event.delta);
          } catch {
            // 忽略无法解析的中间数据
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "流式读取失败");
    return false;
  }
  return true;
}

export async function fetchHealth(): Promise<HealthInfo | null> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as HealthInfo;
  } catch {
    return null;
  }
}
