import { findTool, toolSchemas } from "./tools/index.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const SYSTEM_PROMPT =
  "你是一个面向前端开发者的 AI 助手。若用户询问天气，请优先调用天气工具；若用户询问当前时间，请优先调用时间工具；回答时结合上下文，但不要复述全部历史；答案尽量简洁、准确、贴近实践。";
const MAX_CONTEXT_MESSAGES = 8;

export interface ChatStreamMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CreateChatStreamOptions {
  messages: ChatStreamMessage[];
  model?: string;
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  forceMock?: boolean;
  systemPrompt?: string;
  maxContextMessages?: number;
  onDelta: (delta: string) => void;
  onTrace?: (event: { type: "tool_call"; name: string; arguments: unknown } | { type: "tool_result"; name: string; result: unknown }) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function splitReply(reply: string, size: number) {
  const chars = Array.from(reply);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

async function streamMock({ messages, signal, onDelta }: CreateChatStreamOptions) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt = lastUser?.content.trim() || "你好";
  const reply = `你好！你刚才说的是：“${prompt}”。当前处于 Mock 模式：请求已经走了完整的 fetch + ReadableStream 链路，只是回复由本地模拟生成。配置 LLM_API_KEY 后即可切换到真实模型。`;

  for (const chunk of splitReply(reply, 4)) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    onDelta(chunk);
    await sleep(24);
  }
}

interface ProviderToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface ProviderChoice {
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ProviderToolCall[];
  };
}

type ProviderMessage =
  | ChatStreamMessage
  | { role: "assistant"; content: string | null; tool_calls: ProviderToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toToolResultMessage(toolCallId: string, result: unknown): ProviderMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  };
}

async function requestCompletion(
  messages: ProviderMessage[],
  options: CreateChatStreamOptions,
  apiKey: string,
): Promise<ProviderChoice> {
  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: options.model ?? process.env.LLM_MODEL ?? "deepseek-chat",
      messages,
      tools: toolSchemas,
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`LLM 请求失败 (${response.status})${raw ? `: ${raw.slice(0, 200)}` : ""}`);
  }

  const data = JSON.parse(raw) as { choices?: ProviderChoice[] };
  return data.choices?.[0] ?? {};
}

function runToolCall(call: ProviderToolCall): unknown {
  const tool = findTool(call.function.name);
  if (!tool) {
    return { error: `未知工具: ${call.function.name}` };
  }
  return tool.run(call.function.arguments);
}

/** 对照 Demo 的 runConversation：决定 → 执行 → 回填 → 再问模型拿最终回答。 */
async function runConversation(options: CreateChatStreamOptions, apiKey: string) {
  const messages: ProviderMessage[] = [...options.messages];

  const firstChoice = await requestCompletion(messages, options, apiKey);
  console.log("\n=== 1) 模型第一次返回 ===");
  console.log(JSON.stringify(firstChoice, null, 2));

  const firstMessage = firstChoice.message;
  if (!firstMessage) {
    options.onDelta("");
    return;
  }
  const toolCalls = firstMessage?.tool_calls;
  if (!toolCalls?.length) {
    options.onDelta(firstMessage?.content ?? "");
    return;
  }

  messages.push({
    role: "assistant",
    content: firstMessage.content ?? null,
    tool_calls: toolCalls,
  });

  for (const call of toolCalls) {
    let parsedArgs: unknown = call.function.arguments;
    try {
      parsedArgs = JSON.parse(call.function.arguments);
    } catch {
      // 保留原始字符串，交给校验结果展示
    }
    options.onTrace?.({
      type: "tool_call",
      name: call.function.name,
      arguments: parsedArgs,
    });

    const result = runToolCall(call);
    console.log("\n=== 2) 工具执行结果 ===");
    console.log(JSON.stringify(result, null, 2));
    options.onTrace?.({
      type: "tool_result",
      name: call.function.name,
      result,
    });
    messages.push(toToolResultMessage(call.id, result));
  }

  console.log("\n=== 3) 回填后的 messages ===");
  console.log(JSON.stringify(messages, null, 2));

  const finalChoice = await requestCompletion(messages, options, apiKey);
  const finalContent = finalChoice.message?.content ?? "";
  console.log("\n=== 4) 模型最终回答 ===");
  console.log(finalContent);
  options.onDelta(finalContent);
}

export async function createChatStream(options: CreateChatStreamOptions) {
  const apiKey = options.apiKey ?? process.env.LLM_API_KEY?.trim() ?? "";
  const forceMock = options.forceMock ?? process.env.MOCK_MODE === "1";
  const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
  const maxContextMessages = options.maxContextMessages ?? MAX_CONTEXT_MESSAGES;

  const clippedMessages = clipMessages(options.messages, systemPrompt, maxContextMessages);

  if (forceMock || !apiKey) {
    await streamMock({ ...options, messages: clippedMessages });
    return;
  }
  await runConversation({ ...options, messages: clippedMessages }, apiKey);
}

function clipMessages(
  messages: ChatStreamMessage[],
  systemPrompt: string,
  maxContextMessages: number,
) : ChatStreamMessage[] {
  const userMessages = messages.slice(-Math.max(1, maxContextMessages));
  return [{ role: "system", content: systemPrompt }, ...userMessages];
}
