/**
 * LangSmith Tracing 适配层（阶段 5 · Tracing）
 *
 * ## 这层是干什么的
 *
 * 把 `/api/chat` 的 ReAct 循环上报到 LangSmith，方便开发者在网页里看 span 树、耗时、错误。
 * **不是**给用户看的：页面上的 `ToolTracePanel` 仍走 SSE `onTrace`，两者职责分开。
 *
 * ## 为什么不用 LangChain 自带的 ChatModel 回调
 *
 * 我们的 LLM 调用在 `complete.ts` 里是手写 `fetch`（DeepSeek 兼容接口 + 思考模式 reasoning_content），
 * 没有走 `@langchain/openai` 的 ChatModel，所以 LangChainTracer 不会自动包住每一次 HTTP。
 * 这里用 langsmith 的 `traceable()` 在关键节点**手动**打 span，和 LangGraph 节点一一对应。
 *
 * ## 环境变量（写在 `.env.local`，勿提交 git）
 *
 * | 变量 | 作用 |
 * |------|------|
 * | `LANGCHAIN_TRACING_V2=true` | 开关；为 false 或未设时，下面函数仍可调，但不会上报 |
 * | `LANGCHAIN_API_KEY` | LangSmith API Key；决定进哪个 **Workspace**（如 Workspace 1） |
 * | `LANGCHAIN_PROJECT` | trace 分组名（如 `step1-chat-dev`）；**不是** Workspace 名，不存在会自动创建 |
 *
 * 也可用 `LANGSMITH_*` 前缀，与 LangChain 文档等价。
 *
 * ## LangSmith 里应看到的 span 树（示例：「广州天气，顺便查查几点」）
 *
 * ```
 * chat-request          run_type: chain   ← runConversation 整次 invoke
 *   ├─ askModel         run_type: llm     turn=1，可能出 getWeather
 *   ├─ tool             run_type: tool     tool_name=getWeather
 *   ├─ askModel         run_type: llm     turn=2，可能出 getCurrentTime
 *   ├─ tool             run_type: tool     tool_name=getCurrentTime
 *   └─ askModel         run_type: llm     turn=3，无 tool_calls，生成最终文字
 * ```
 *
 * ## 谁在调用本文件
 *
 * - `runConversation.ts`：`traceChatRequest` 包整段图；`askModel` 节点里调 `traceAskModel`
 * - `applyToolCalls.ts`：每个 tool_call 经 `runToolWithTracing` → `traceToolRun`
 * - `ragChat.ts` / `answer.ts`：`traceRagRequest` → `traceRagRetrieve` / `traceRagLlm`
 *
 * ## 刻意不上报 / 截断的内容
 *
 * - 完整 `messages` 数组（太长、易含历史）；askModel 只记 message_count
 * - `LLM_API_KEY`、用户 API Key
 * - 工具结果超过 500 字的 JSON（`result_preview` 截断）
 * - 用户问句超过 120 字（`user_preview` 截断）
 *
 * 详细学习计划：`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`
 */

import { traceable } from "langsmith/traceable";
import { requestCompletion } from "../react/complete.js";
import type { ProviderChoice, ProviderMessage, ProviderToolCall, ReactLoopOptions } from "../react/types.js";
import { findTool } from "../tools/index.js";

/**
 * 是否开启 LangSmith 上报。
 * 与 `@langchain/core` 一致：任一路径的 TRACING 环境变量为 `"true"` 即视为开启。
 * runConversation / applyToolCalls 用它决定走 traceable 还是原来的直调路径。
 */
export function isLangSmithTracingEnabled(): boolean {
  const flags = [
    process.env.LANGCHAIN_TRACING_V2,
    process.env.LANGSMITH_TRACING_V2,
    process.env.LANGCHAIN_TRACING,
    process.env.LANGSMITH_TRACING,
  ];
  return flags.some((value) => value === "true");
}

/**
 * 根 span：一次 `/api/chat` 请求对应的整段 ReAct（LangGraph 从 START 跑到 END）。
 *
 * - 调用处：`runConversation()` 在最外层包一层，内部仍是原来的 `graph.invoke`
 * - `userPreview`：最后一条 user 消息摘要，方便在 LangSmith 列表里认是哪句问话
 * - `run`：闭包，避免 traceable 和图编译逻辑耦死
 *
 * LangSmith UI 里名称显示为 `chat-request`，类型 chain。
 */
export const traceChatRequest = traceable(
  async (input: { run: () => Promise<void>; userPreview: string }) => {
    await input.run();
  },
  {
    name: "chat-request",
    run_type: "chain",
    processInputs: (inputs) => ({
      user_preview: inputs.userPreview.slice(0, 120),
    }),
  },
);

/**
 * LLM span：LangGraph `askModel` 节点里每一次 `requestCompletion`。
 *
 * 对应关系：
 * - 代码：`complete.ts` → POST chat/completions（带 tools）
 * - 图：`runConversation.ts` 的 askModel 节点，每轮 turn 一次
 *
 * processInputs 只记摘要，避免把整段 messages（含 system、tool 回填）打进 LangSmith。
 * processOutputs 重点看模型有没有出 tool_calls——排错「没调时间工具」时先看 `has_tool_calls` / `tool_names`。
 *
 * 注意：thinking 模式的 `reasoning_content` 不在此处单独 span；仍随 messages 在 complete 里回填。
 */
export const traceAskModel = traceable(
  async (input: {
    turn: number;
    messages: ProviderMessage[];
    options: ReactLoopOptions;
    apiKey: string;
  }): Promise<ProviderChoice> => {
    const { choice } = await requestCompletion(input.messages, input.options, input.apiKey);
    return choice;
  },
  {
    name: "askModel",
    run_type: "llm",
    processInputs: (inputs) => ({
      turn: inputs.turn,
      model: inputs.options.model ?? process.env.LLM_MODEL ?? "deepseek-chat",
      message_count: inputs.messages.length,
      search_docs: Boolean(inputs.options.searchDocs),
    }),
    processOutputs: (outputs) => {
      const message = outputs.message;
      const toolCalls = message?.tool_calls ?? [];
      return {
        finish_reason: outputs.finish_reason ?? null,
        has_tool_calls: toolCalls.length > 0,
        tool_names: toolCalls.map((call) => call.function.name),
        content_preview: message?.content?.slice(0, 200) ?? null,
      };
    },
  },
);

/**
 * Tool span：单次 tool_call 的执行（getWeather / getCurrentTime / searchDocs …）。
 *
 * - 调用处：`applyToolCalls` → `runToolWithTracing` → 本函数
 * - `tool_name` 用真实函数名，LangSmith 里可按名筛选
 * - `is_error`：结果为 `{ error: "..." }` 时为 true（含火星天气、连续失败停止等）
 *
 * 业务逻辑仍在 `tools/methods/*` 的 `run*`；这里只包观测，不重写校验。
 */
export const traceToolRun = traceable(
  async (input: {
    turn: number;
    call: ProviderToolCall;
    run: () => Promise<unknown>;
  }): Promise<unknown> => {
    return input.run();
  },
  {
    name: "tool",
    run_type: "tool",
    processInputs: (inputs) => {
      let parsedArgs: unknown = inputs.call.function.arguments;
      try {
        parsedArgs = JSON.parse(inputs.call.function.arguments);
      } catch {
        // 模型偶发非法 JSON；LangSmith 仍展示原始字符串
      }
      return {
        turn: inputs.turn,
        tool_name: inputs.call.function.name,
        arguments: parsedArgs,
      };
    },
    processOutputs: (outputs) => {
      const hasError = Boolean(outputs && typeof outputs === "object" && "error" in outputs);
      return {
        is_error: hasError,
        result_preview: JSON.stringify(outputs).slice(0, 500),
      };
    },
  },
);

/**
 * 工具执行统一入口：Tracing 开 → `traceToolRun`；关 → 直接 `tool.run`。
 *
 * 为何不把 trace 写死在 `tools/methods/` 里？
 * - methods 层应保持「可被 /api/chat、MCP、以后 Evals 共用」
 * - 观测是调用方（ReAct 循环）的责任，和 MCP 协议层一样保持边界
 *
 * 异常仍转为 `{ error }` 回填模型，不往外 throw，与阶段 4 工具失败策略一致。
 */
export async function runToolWithTracing(
  turn: number,
  call: ProviderToolCall,
): Promise<unknown> {
  const tool = findTool(call.function.name);
  if (!tool) {
    return { error: `未知工具: ${call.function.name}` };
  }
  const execute = () => tool.run(call.function.arguments);
  if (!isLangSmithTracingEnabled()) {
    try {
      return await execute();
    } catch (error) {
      return { error: error instanceof Error ? error.message : "工具执行失败" };
    }
  }
  return traceToolRun({
    turn,
    call,
    run: async () => {
      try {
        return await execute();
      } catch (error) {
        return { error: error instanceof Error ? error.message : "工具执行失败" };
      }
    },
  });
}

/**
 * 从 messages 末尾取最后一条 user 文本，供 `chat-request` 的 inputs 展示。
 * 跳过 assistant / tool 回填，只对应当前这轮用户输入（clip 后通常就是本句问话）。
 */
export function lastUserPreview(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role === "user" && "content" in row) {
      return row.content.trim();
    }
  }
  return "";
}

/**
 * 根 span：一次 `/api/rag/chat`（资料问答）整段请求。
 * 与 chat-request 并列；内部再挂 retrieve + rag-llm。
 */
export const traceRagRequest = traceable(
  async (input: { run: () => Promise<void>; userPreview: string }) => {
    await input.run();
  },
  {
    name: "rag-request",
    run_type: "chain",
    processInputs: (inputs) => ({
      user_preview: inputs.userPreview.slice(0, 120),
    }),
  },
);

/**
 * Tool span：RAG 路径上的向量检索（语义对齐 searchDocs，实际跑 retrieveForAnswer）。
 * 调用前已过 validateToolCall；本层只观测。
 */
export const traceRagRetrieve = traceable(
  async (input: { question: string; run: () => Promise<unknown> }): Promise<unknown> => {
    return input.run();
  },
  {
    name: "rag-retrieve",
    run_type: "tool",
    processInputs: (inputs) => ({
      tool_name: "searchDocs",
      question_preview: inputs.question.slice(0, 120),
    }),
    processOutputs: (outputs) => {
      const row = outputs as {
        empty?: boolean;
        topScore?: number | null;
        hitCount?: number;
      } | null;
      return {
        empty: row?.empty ?? null,
        top_score: row?.topScore ?? null,
        hit_count: row?.hitCount ?? null,
      };
    },
  },
);

/**
 * LLM span：RAG 的 completeRagMessages（无 tools）。
 */
export const traceRagLlm = traceable(
  async (input: {
    messageCount: number;
    model: string;
    run: () => Promise<{ content: string; usage: unknown; model: string }>;
  }) => {
    return input.run();
  },
  {
    name: "rag-llm",
    run_type: "llm",
    processInputs: (inputs) => ({
      model: inputs.model,
      message_count: inputs.messageCount,
    }),
    processOutputs: (outputs) => ({
      content_preview: outputs.content?.slice(0, 200) ?? null,
      has_usage: Boolean(outputs.usage),
    }),
  },
);

/** 开关开 → traceRagRetrieve；关 → 直接 run。 */
export async function runRagRetrieveWithTracing<T>(
  question: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) {
    return run();
  }
  return traceRagRetrieve({ question, run }) as Promise<T>;
}

/** 开关开 → traceRagLlm；关 → 直接 run。 */
export async function runRagLlmWithTracing<T extends { content: string; usage: unknown; model: string }>(
  messageCount: number,
  model: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) {
    return run();
  }
  return traceRagLlm({ messageCount, model, run }) as Promise<T>;
}
