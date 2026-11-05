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
 * chat-request          run_type: chain
 *   ├─ chat-prefetch?   若勾选知识库（语义 C）
 *   ├─ chat-llm         turn=1（工具轮，thinking 默认 disabled）
 *   ├─ tool             getWeather
 *   └─ chat-llm         turn=2…
 * ```
 *
 * ## 谁在调用本文件
 *
 * - `runConversation.ts`：`traceChatRequest`；节点内 `traceAskModel`（span 名 chat-llm）
 * - `prefetchSearchDocs.ts`：`runPrefetchWithTracing` → chat-prefetch
 * - `applyToolCalls.ts`：`runToolWithTracing` → `traceToolRun`
 * - `ragChat.ts` / `answer.ts`：`traceRagRequest` → rag-retrieve / rag-llm
 * - `chatMulti.ts` / `multi-agent/*`：`traceMultiRequest` → multi-* spans
 *
 * ## 刻意不上报 / 截断的内容
 *
 * - 完整 `messages` 数组（太长、易含历史）；chat-llm 只记 message_count
 * - `LLM_API_KEY`、用户 API Key
 * - 工具结果超过 500 字的 JSON（`result_preview` 截断）
 * - 用户问句超过 120 字（`user_preview` 截断）
 *
 * 详细学习计划：`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`
 * post-learning：`docs/post-learning-optimization-changelog.md`
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
 * 名称刻意用 `chat-llm`（不用 askModel），避免与 LangGraph 节点名叠两层同名，
 * 排错时不会误以为跑了两次 LLM。
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
    const { choice } = await requestCompletion(input.messages, input.options, input.apiKey, {
      disableThinking: true,
    });
    return choice;
  },
  {
    name: "chat-llm",
    run_type: "llm",
    processInputs: (inputs) => ({
      turn: inputs.turn,
      model: inputs.options.model ?? process.env.LLM_MODEL ?? "deepseek-chat",
      message_count: inputs.messages.length,
      search_docs_prefetch: Boolean(inputs.options.searchDocs),
      thinking: "disabled",
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
 * Tool span：聊天路径上的 prefetch 检索（语义 C：服务端必检索）。
 * 与模型 tool_calls 的 `tool` span 区分：本 span 名 `chat-prefetch`。
 */
export const traceChatPrefetch = traceable(
  async (input: {
    question: string;
    candidateK: number;
    run: () => Promise<unknown>;
  }): Promise<unknown> => input.run(),
  {
    name: "chat-prefetch",
    run_type: "tool",
    processInputs: (inputs) => ({
      tool_name: "searchDocs",
      path: "prefetch",
      question_preview: inputs.question.slice(0, 120),
      candidate_k: inputs.candidateK,
    }),
    processOutputs: (outputs) => {
      const row = outputs as { error?: string; empty?: boolean; hits?: unknown[] } | null;
      return {
        is_error: Boolean(row && "error" in row && row.error),
        hit_count: Array.isArray(row?.hits) ? row.hits.length : null,
        result_preview: JSON.stringify(outputs).slice(0, 500),
      };
    },
  },
);

/** 开关开 → chat-prefetch span；关 → 直接 run。 */
export async function runPrefetchWithTracing<T>(
  question: string,
  candidateK: number,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) {
    return run();
  }
  return traceChatPrefetch({ question, candidateK, run }) as Promise<T>;
}
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

/**
 * 根 span：一次 `/api/chat/multi`（多 Agent）整段请求。
 * 与 chat-request / rag-request 并列。
 *
 * LangSmith 树示例（「广州天气，顺便查笔记」）：
 * ```
 * multi-request
 *   ├─ multi-supervisor
 *   │    └─ multi-llm          role=supervisor
 *   ├─ multi-workers
 *   │    ├─ multi-worker       worker=realtime
 *   │    │    ├─ multi-llm     turn=0
 *   │    │    ├─ tool          getWeather
 *   │    │    └─ multi-llm     turn=1
 *   │    └─ multi-worker       worker=kb
 *   │         ├─ multi-llm
 *   │         └─ tool          searchDocs
 *   └─ multi-aggregate
 *        └─ multi-llm          role=aggregate（单 Worker 透传时可能无此 LLM）
 * ```
 */
export const traceMultiRequest = traceable(
  async (input: { run: () => Promise<void>; userPreview: string }) => {
    await input.run();
  },
  {
    name: "multi-request",
    run_type: "chain",
    processInputs: (inputs) => ({
      user_preview: inputs.userPreview.slice(0, 120),
    }),
  },
);

/** chain：Supervisor 路由节点。 */
export const traceMultiSupervisor = traceable(
  async (input: { run: () => Promise<unknown> }): Promise<unknown> => input.run(),
  {
    name: "multi-supervisor",
    run_type: "chain",
  },
);

/** chain：Workers 并行节点（内部再挂各 multi-worker）。 */
export const traceMultiWorkers = traceable(
  async (input: { workerNames: string[]; run: () => Promise<unknown> }): Promise<unknown> =>
    input.run(),
  {
    name: "multi-workers",
    run_type: "chain",
    processInputs: (inputs) => ({
      workers: inputs.workerNames,
      worker_count: inputs.workerNames.length,
    }),
  },
);

/** chain：单个 Worker 执行（含内部 mini ReAct）。 */
export const traceMultiWorker = traceable(
  async (input: {
    worker: string;
    task: string;
    run: () => Promise<unknown>;
  }): Promise<unknown> => input.run(),
  {
    name: "multi-worker",
    run_type: "chain",
    processInputs: (inputs) => ({
      worker: inputs.worker,
      task_preview: inputs.task.slice(0, 120),
    }),
  },
);

/** chain：Aggregate 汇总节点。 */
export const traceMultiAggregate = traceable(
  async (input: { workerCount: number; run: () => Promise<unknown> }): Promise<unknown> =>
    input.run(),
  {
    name: "multi-aggregate",
    run_type: "chain",
    processInputs: (inputs) => ({
      worker_count: inputs.workerCount,
    }),
  },
);

/**
 * LLM span：多 Agent 路径上每一次 `callLLM`（Supervisor / Worker / Aggregate）。
 * 与 askModel / rag-llm 并列；不走 requestCompletion，故单独打点。
 */
export const traceMultiLlm = traceable(
  async (input: {
    role: "supervisor" | "worker" | "aggregate";
    worker?: string;
    turn?: number;
    messageCount: number;
    model: string;
    hasTools: boolean;
    run: () => Promise<unknown>;
  }): Promise<unknown> => input.run(),
  {
    name: "multi-llm",
    run_type: "llm",
    processInputs: (inputs) => ({
      role: inputs.role,
      worker: inputs.worker ?? null,
      turn: inputs.turn ?? null,
      model: inputs.model,
      message_count: inputs.messageCount,
      has_tools: inputs.hasTools,
    }),
    processOutputs: (outputs) => {
      const row = outputs as {
        ok?: boolean;
        content?: string | null;
        toolCalls?: { function: { name: string } }[];
      };
      const toolCalls = row.toolCalls ?? [];
      return {
        ok: row.ok ?? null,
        has_tool_calls: toolCalls.length > 0,
        tool_names: toolCalls.map((c) => c.function.name),
        content_preview: row.content?.slice(0, 200) ?? null,
      };
    },
  },
);

/** 多 Agent LLM：开关开 → traceMultiLlm；关 → 直接 run。 */
export async function runMultiLlmWithTracing<T>(
  meta: {
    role: "supervisor" | "worker" | "aggregate";
    worker?: string;
    turn?: number;
    messageCount: number;
    model: string;
    hasTools: boolean;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) {
    return run();
  }
  return traceMultiLlm({ ...meta, run }) as Promise<T>;
}

/** 根 span 包装：开关开 → multi-request；关 → 直接 run。 */
export async function runMultiRequestWithTracing(
  userPreview: string,
  run: () => Promise<void>,
): Promise<void> {
  if (!isLangSmithTracingEnabled()) {
    await run();
    return;
  }
  await traceMultiRequest({ userPreview, run });
}

/** Supervisor 节点 chain。 */
export async function withMultiSupervisorSpan<T>(run: () => Promise<T>): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return traceMultiSupervisor({ run }) as Promise<T>;
}

/** Workers 并行节点 chain。 */
export async function withMultiWorkersSpan<T>(
  workerNames: string[],
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return traceMultiWorkers({ workerNames, run }) as Promise<T>;
}

/** 单个 Worker chain。 */
export async function withMultiWorkerSpan<T>(
  worker: string,
  task: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return traceMultiWorker({ worker, task, run }) as Promise<T>;
}

/** Aggregate 节点 chain。 */
export async function withMultiAggregateSpan<T>(
  workerCount: number,
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return traceMultiAggregate({ workerCount, run }) as Promise<T>;
}

/** 最终 schema 失败时写入 trace 的精简 issue，不包含模型完整原文。 */
export interface StructuredTraceIssue {
  path: Array<string | number>;
  code: string;
  expected: string | null;
  actualType: string;
  message: string;
}

/** 一次结构化请求结束时交给 LangSmith 根 span 的诊断快照。 */
export interface StructuredTraceOutcome {
  status: "completed" | "failed" | "aborted";
  model: string;
  target: string;
  lastRevision: number;
  errorCode: string | null;
  validationCode: string | null;
  validationIssues: StructuredTraceIssue[];
  repairApplied: string | null;
  jsonModeFallback: boolean;
  usageRecorded: boolean;
  chunkCount: number;
  rejectedChunkCount: number;
  lastRejectedChunkDiagnostic: string | null;
}

/** 根 span 输入只保留脱敏后的用户预览和请求元数据。 */
export interface StructuredTraceMeta {
  userPreview: string;
  model: string;
  target: string;
  messageCount: number;
  jsonModeRequested: boolean;
}

/** 根 span：一次 /api/chat/structured 请求，不记录完整 prompt 或模型原文。 */
export const traceStructuredRequest = traceable(
  async (input: { meta: StructuredTraceMeta; run: () => Promise<StructuredTraceOutcome> }) =>
    input.run(),
  {
    name: "structured-request",
    run_type: "chain",
    processInputs: (inputs) => ({
      model: inputs.meta.model,
      target: inputs.meta.target,
      message_count: inputs.meta.messageCount,
      json_mode_requested: inputs.meta.jsonModeRequested,
      user_preview: inputs.meta.userPreview.slice(0, 120),
    }),
    processOutputs: (outputs) => ({
      status: outputs.status,
      model: outputs.model,
      target: outputs.target,
      last_revision: outputs.lastRevision,
      error_code: outputs.errorCode,
      validation_code: outputs.validationCode,
      validation_issue_count: outputs.validationIssues.length,
      validation_issues: outputs.validationIssues.slice(0, 10),
      repair_applied: outputs.repairApplied,
      json_mode_fallback: outputs.jsonModeFallback,
      usage_recorded: outputs.usageRecorded,
      chunk_count: outputs.chunkCount,
      rejected_chunk_count: outputs.rejectedChunkCount,
      last_rejected_chunk_diagnostic: outputs.lastRejectedChunkDiagnostic,
    }),
  },
);

/** LLM span：结构化模型流；JSON mode 降级后的重试会单独产生一条 span。 */
export const traceStructuredLlm = traceable(
  async (input: {
    model: string;
    target: string;
    messageCount: number;
    jsonMode: boolean;
    run: () => Promise<unknown>;
  }): Promise<unknown> => input.run(),
  {
    name: "structured-llm",
    run_type: "llm",
    processInputs: (inputs) => ({
      model: inputs.model,
      target: inputs.target,
      message_count: inputs.messageCount,
      json_mode: inputs.jsonMode,
    }),
    processOutputs: (outputs) => {
      const row = outputs as {
        status?: string;
        error?: { code?: string };
        usage?: unknown;
        stats?: {
          finishReason?: string | null;
          chunkCount?: number;
          receivedChars?: number;
          sawDone?: boolean;
        };
      } | null;
      return {
        status: row?.status ?? null,
        error_code: row?.error?.code ?? null,
        finish_reason: row?.stats?.finishReason ?? null,
        chunk_count: row?.stats?.chunkCount ?? null,
        received_chars: row?.stats?.receivedChars ?? null,
        saw_done: row?.stats?.sawDone ?? null,
        has_usage: Boolean(row?.usage),
      };
    },
  },
);

/** 根 span 包装：开关开 → structured-request；关 → 直接 run。 */
export async function runStructuredRequestWithTracing(
  meta: StructuredTraceMeta,
  run: () => Promise<StructuredTraceOutcome>,
): Promise<StructuredTraceOutcome> {
  // 未开启 tracing 时保持零额外网络调用，直接执行原业务函数。
  if (!isLangSmithTracingEnabled()) return run();
  return traceStructuredRequest({ meta, run });
}

/**
 * 为一次真实模型流创建 LLM span。
 *
 * JSON mode 不受支持后的 prompt-only 重试会再次调用本函数，因此 trace 中能看到
 * 两次独立模型尝试；Mock 分支不经过这里。
 */
export async function runStructuredCompletionWithTracing<T>(
  meta: {
    model: string;
    target: string;
    messageCount: number;
    jsonMode: boolean;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return traceStructuredLlm({ ...meta, run }) as Promise<T>;
}

/**
 * LLM span：Plan-and-Execute 的规划调用。
 *
 * 与 chat-llm 并列但只看 Planner 这一段：
 * - 只挂 emit_plan 工具，模型不调业务工具
 * - 输出重点是「计划是否成形」：步数、校验错误码、是否走了 fallback
 * - latency_ms 单独记，规划慢是这类架构最常见的体感问题
 */
export const tracePlanPlanner = traceable(
  async (input: {
    planId: string;
    revision: number;
    model: string;
    run: () => Promise<{
      hasToolCall: boolean;
      stepCount: number | null;
      validationCode: string | null;
      fellBack: boolean;
      latencyMs: number;
      modelCalls: number;
    }>;
  }) => input.run(),
  {
    name: "plan-planner",
    run_type: "llm",
    processInputs: (inputs) => ({
      plan_id: inputs.planId,
      revision: inputs.revision,
      model: inputs.model,
    }),
    processOutputs: (outputs) => ({
      has_tool_call: outputs.hasToolCall,
      step_count: outputs.stepCount,
      validation_code: outputs.validationCode,
      fell_back: outputs.fellBack,
      latency_ms: outputs.latencyMs,
      model_calls: outputs.modelCalls,
    }),
  },
);

/** 开关开 → plan-planner span；关 → 直接 run。 */
export async function runPlanPlannerWithTracing<T extends {
  hasToolCall: boolean;
  stepCount: number | null;
  validationCode: string | null;
  fellBack: boolean;
  latencyMs: number;
  modelCalls: number;
}>(
  meta: { planId: string; revision: number; model: string },
  run: () => Promise<T>,
): Promise<T> {
  if (!isLangSmithTracingEnabled()) return run();
  return tracePlanPlanner({ ...meta, run }) as Promise<T>;
}

/* ---------------- 计划请求的观测字段与根 span（步骤 11） ---------------- */

/**
 * 一次计划请求的观测字段（步骤 11 契约）。
 *
 * 13 个字段覆盖三类问题：
 - 走到哪一步：planId / revision / mode / reasonCode / stepId
 - 花了多少：modelCalls / toolCalls / plannerLatencyMs / totalLatencyMs / replanCount
 - 怎么结束的：abortReason / errorCode
 *
 * requestId 把「前端一次请求」和「服务端日志一条」对上；
 * user_preview 只取最后一条用户消息的短预览，不落完整 prompt。
 */
export interface PlanObservation {
  requestId: string;
  planId: string;
  revision: number;
  mode: string;
  reasonCode: string | null;
  stepId: string | null;
  modelCalls: number;
  toolCalls: number;
  replanCount: number;
  plannerLatencyMs: number;
  totalLatencyMs: number;
  abortReason: string | null;
  errorCode: string | null;
}

/** 根 span：一次 `/api/chat/plan` 请求对应的整段计划执行。 */
export const tracePlanRequest = traceable(
  async (input: {
    requestId: string;
    planId: string;
    mode: string;
    userPreview: string;
    run: () => Promise<PlanObservation>;
  }): Promise<PlanObservation> => input.run(),
  {
    name: "plan-request",
    run_type: "chain",
    processInputs: (inputs) => ({
      request_id: inputs.requestId,
      plan_id: inputs.planId,
      mode: inputs.mode,
      user_preview: inputs.userPreview.slice(0, 120),
    }),
    processOutputs: (outputs) => ({
      request_id: outputs.requestId,
      plan_id: outputs.planId,
      revision: outputs.revision,
      mode: outputs.mode,
      reason_code: outputs.reasonCode,
      step_id: outputs.stepId,
      model_calls: outputs.modelCalls,
      tool_calls: outputs.toolCalls,
      replan_count: outputs.replanCount,
      planner_latency_ms: outputs.plannerLatencyMs,
      total_latency_ms: outputs.totalLatencyMs,
      abort_reason: outputs.abortReason,
      error_code: outputs.errorCode,
    }),
  },
);

/** 开关开 → plan-request span；关 → 直接 run。 */
export async function runPlanRequestWithTracing(
  meta: { requestId: string; planId: string; mode: string; userPreview: string },
  run: () => Promise<PlanObservation>,
): Promise<PlanObservation> {
  if (!isLangSmithTracingEnabled()) return run();
  return tracePlanRequest({ ...meta, run });
}
