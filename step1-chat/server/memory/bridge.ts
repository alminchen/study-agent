/**
 * 记忆链路和业务链路之间的桥接层。
 *
 * 这个文件只做两件事：
 * 1. 把「检索记忆」包装成一次调用，失败返回 null，不抛异常；
 * 2. 把「抽取记忆」包装成旁路任务，不阻塞主回复，失败只发事件。
 *
 * 之所以单独抽出来，是因为 /api/chat、/api/chat/multi、/api/chat/plan、
 * /api/rag/chat、/api/chat/structured 都要用同一套记忆口径：
 * 开关关闭就完全不动，失败不阻断回复，事件形状保持一致。
 */

import type { ContextMemoryBlock } from "../context/types.js";
import type { ToolTraceHandler } from "../react/types.js";
import type { TokenUsage } from "../usage/types.js";
import { renderMemoryBlock } from "./context.js";
import {
  createMemoryModelCaller,
  type MemoryConversationMessage,
} from "./extract.js";
import { extractAndStoreFacts } from "./pipeline.js";
import { retrieveRelevantFacts } from "./retrieve.js";
import { isValidUserId } from "./types.js";
import type { MemoryInjectedItem, MemoryTraceEvent } from "./types.js";

/** 一次最多注入几条记忆。 */
const MEMORY_INJECT_LIMIT = 5;

/** 记忆抽取的整体超时（毫秒）。 */
const MEMORY_EXTRACT_TIMEOUT_MS = 8_000;

/** 记忆桥接层的公共入参。 */
export interface MemoryBridgeOptions {
  /** 匿名用户 id；非法 id 按「没开记忆」处理。 */
  userId?: string;
  /** 是否启用记忆；false / 不传时不检索、不抽取。 */
  allowMemory?: boolean;
  /** 抽取这次模型调用使用的模型名。 */
  model?: string;
  /** 记忆过程事件回调（memory_injected / memory_extracted / memory_failed）。 */
  onTrace?: (event: MemoryTraceEvent) => void;
  /** 记忆抽取这次模型调用的 usage，单独记账。 */
  onMemoryUsage?: (usage: TokenUsage, model: string) => void;
}

/** 记忆抽取依赖的模型调用配置。 */
export interface MemoryExtractionDeps {
  apiKey: string;
  forceMock: boolean;
  baseUrl: string;
}

/**
 * 抽取输入的裁剪参数。
 *
 * 四条链路的对话形状不一样（multi 有 worker 工具返回、rag 有检索片段、
 * structured 只有一条指令），但**同一条口径**：
 * 抽取器只该看到「用户说的话」和「给用户的最终回答」。
 * 工具返回、检索资料、生成的 JSON 都不是用户事实，
 * 混进去会被记成用户偏好，越聊越脏。
 */
export interface ExtractionInputOptions {
  /** 客户端传来的对话（可能混有 system / tool 角色，只取 user）。 */
  messages?: { role?: string; content?: unknown }[];
  /** 本轮给用户的最终回复，作为 assistant 轮参与抽取。 */
  finalReply?: string;
  /** 保留最近几轮用户消息，默认 2 轮。 */
  rounds?: number;
}

/**
 * 构造 memory_injected 事件。
 *
 * 四条链路都要发这个事件，形状必须**完全一致**：
 * 前端只认一份协议，谁自己拼一遍就多一个出错的地方。
 *
 * @param items 本轮真正注入的条目（预算裁剪后留下来的那几条）
 * @param tokens 记忆层占用的估算 token
 */
export function buildMemoryInjectedEvent(
  items: Array<{ id: string; key?: string; value?: string; similarity: number }>,
  tokens: number,
): MemoryTraceEvent {
  const injected: MemoryInjectedItem[] = items.map((item) => ({
    id: item.id,
    key: item.key ?? "",
    value: item.value ?? "",
    similarity: item.similarity,
  }));
  return {
    type: "memory_injected",
    itemIds: injected.map((item) => item.id),
    tokens,
    items: injected,
  };
}

/**
 * 按统一口径裁出本轮的抽取输入。
 *
 * 规则：
 * 1. 只保留最近 N 轮**用户消息**（默认 2 轮），中间的助手回复一律不取——
 *    多 Agent 的助手回复里混着 worker 的工具结果和汇总，分不清就干脆不要。
 * 2. 最后补一条 assistant = 本轮给用户的最终回复，那是「模型给出的答案」，
 *    里面可能包含用户刚表达的偏好（「以后都用中文」）。
 * 3. 没有最终回复时（structured 只有指令型输入），只留用户消息。
 */
export function buildExtractionInput(
  options: ExtractionInputOptions,
): MemoryConversationMessage[] {
  const rounds = Math.max(1, options.rounds ?? 2);
  const userMessages: MemoryConversationMessage[] = (options.messages ?? [])
    .filter(
      (message) =>
        message?.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim() !== "",
    )
    .slice(-rounds)
    .map((message) => ({
      role: "user" as const,
      content: message.content as string,
    }));

  const finalReply =
    typeof options.finalReply === "string" ? options.finalReply.trim() : "";
  if (!finalReply) return userMessages;

  return [...userMessages, { role: "assistant", content: finalReply }];
}

/**
 * 检索与当前问题相关的记忆，并渲染成可注入的上下文块。
 *
 * 返回 null 表示这一轮没有可用记忆：可能是开关关闭、id 非法、
 * 没有命中、或检索失败。调用方只需要把 null 当成「没记忆」继续走主链路。
 */
export async function retrieveMemoryBlock(
  options: MemoryBridgeOptions,
  question: string,
): Promise<ContextMemoryBlock | null> {
  const userId = options.userId;
  if (options.allowMemory !== true || !isValidUserId(userId)) return null;
  if (!question.trim()) return null;

  try {
    const retrieved = await retrieveRelevantFacts(userId, question, {
      limit: MEMORY_INJECT_LIMIT,
    });
    if (retrieved.length === 0) return null;
    return renderMemoryBlock(retrieved);
  } catch (error) {
    console.warn("[memory] 检索失败，本轮不注入记忆", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    options.onTrace?.({
      type: "memory_failed",
      stage: "retrieve",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 从本轮对话里抽取事实并落盘（旁路，不 await）。
 *
 * 三个刻意的设计：
 * 1. **不 await**：抽取要多花 1~3 秒，聊天主链路不能为它买单。
 * 2. **不用请求的 AbortSignal**：客户端一断开就取消抽取，
 *    那「模型刚说完就断开」的用户永远存不下任何偏好。
 *    这里用独立控制器 + 自己的超时。
 * 3. **没有 API Key 就跳过**：Mock 模式没有真模型，调了也是假的。
 */
export function scheduleMemoryExtraction(
  options: MemoryBridgeOptions,
  messages: MemoryConversationMessage[],
  deps: MemoryExtractionDeps,
): Promise<void> | null {
  const userId = options.userId;
  if (options.allowMemory !== true || !isValidUserId(userId)) return null;
  if (deps.forceMock || !deps.apiKey) return null;
  if (messages.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_EXTRACT_TIMEOUT_MS);

  const task = (async () => {
    try {
      const callModel = createMemoryModelCaller({
        apiKey: deps.apiKey,
        baseUrl: deps.baseUrl,
        model: options.model ?? "deepseek-chat",
        onUsage: options.onMemoryUsage,
      });
      const outcome = await extractAndStoreFacts({
        userId,
        messages,
        callModel,
        signal: controller.signal,
        timeoutMs: MEMORY_EXTRACT_TIMEOUT_MS,
      });
      options.onTrace?.({
        type: "memory_extracted",
        candidates: outcome.candidates,
        stored: outcome.stored.map((fact) => ({
          id: fact.id,
          key: fact.key,
          value: fact.value,
        })),
      });
    } catch (error) {
      console.warn("[memory] 抽取失败（不影响聊天）", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      options.onTrace?.({
        type: "memory_failed",
        stage: "extract",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  })();

  return task;
}
