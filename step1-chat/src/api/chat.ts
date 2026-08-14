import type { ChatRole, ToolTraceStep } from "../types";

export interface StreamChatParams {
  messages: Array<{ role: ChatRole; content: string }>;
  model: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onTrace?: (step: ToolTraceStep) => void;
  onError: (error: string) => void;
}

export interface HealthInfo {
  mode: "mock" | "api";
  model: string;
}

export async function streamChat({
  messages,
  model,
  signal,
  onDelta,
  onTrace,
  onError,
}: StreamChatParams): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model }),
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
              type?: "tool_call" | "tool_result";
              name?: string;
              arguments?: unknown;
              result?: unknown;
            };
            if (event.error) {
              onError(event.error);
              return true;
            }
            if (event.type === "tool_call" && event.name) {
              onTrace?.({ kind: "tool_call", name: event.name, arguments: event.arguments });
            }
            if (event.type === "tool_result" && event.name) {
              onTrace?.({ kind: "tool_result", name: event.name, result: event.result });
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
