import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { normalizeKnowledgeAnswer } from "../answer-style/knowledgeAnswer.js";
import { detectLeakage } from "../guard/outputGuard.js";
import { applyToolCalls } from "./applyToolCalls.js";
import { requestCompletion } from "./complete.js";
import {
  isLangSmithTracingEnabled,
  lastUserPreview,
  traceAskModel,
  traceChatRequest,
} from "../tracing/langsmith.js";
import { createConsecutiveFailureTracker } from "./toolFailure.js";
import { prefetchSearchDocsIfEnabled } from "./prefetchSearchDocs.js";
import type { ConsecutiveFailureTracker } from "./toolFailure.js";
import type { ProviderMessage, ProviderToolCall, ReactLoopOptions } from "./types.js";

/** 同一条用户问题里，最多问模型几次。防止模型反复要工具、循环停不下来。 */
const MAX_MODEL_TURNS = 5;

/**
 * 图上一直带着走的数据。对应旧 for 循环里的局部变量。
 * 没有 reducer：节点返回哪几个字段，就覆盖哪几个。
 */
const ReactState = Annotation.Root({
  messages: Annotation<ProviderMessage[]>,
  turn: Annotation<number>,
  toolCalls: Annotation<ProviderToolCall[]>,
  assistantContent: Annotation<string | null>,
  /** DeepSeek 思考模式：带 tool_calls 的 assistant 必须把 reasoning_content 原样回填。 */
  assistantReasoningContent: Annotation<string | null>,
  /** 非空表示该出最终文字了，边会走向 reply。 */
  finalText: Annotation<string | null>,
});

type ReactStateType = typeof ReactState.State;

/** 问完模型之后走哪：有最终文字就回复页面，否则去执行工具。对应旧代码里的几个 if。 */
function routeAfterAsk(state: ReactStateType): "applyTools" | "reply" {
  return state.finalText !== null ? "reply" : "applyTools";
}

function pushAssistantWithTools(
  messages: ProviderMessage[],
  content: string | null,
  toolCalls: ProviderToolCall[],
  reasoningContent: string | null,
) {
  const row: ProviderMessage = {
    role: "assistant",
    content,
    tool_calls: toolCalls,
  };
  // 思考模式：带 tool_calls 的 assistant 必须把 reasoning_content 原样带回（空串也要带）。
  if (reasoningContent != null) {
    row.reasoning_content = reasoningContent;
  }
  messages.push(row);
}

/**
 * 把「问模型 / 执行工具 / 交给页面」组装成一张图并 compile。
 *
 * 必须按请求现组：三个节点要闭包这一次的 options、apiKey、failures，
 * 不能做成模块级单例（否则会串到别人的对话、失败计数也会混）。
 *
 * 边：START → askModel →（有工具）applyTools → askModel；
 * 没有工具或次数到了 → reply → END。
 *
 * @param options 这一次聊天的模型地址、中断信号、onDelta / onTrace
 * @param apiKey 调 LLM 用
 * @param failures 同一工具连续失败计数；整张图共用一份，跨节点不能丢
 */
function compileReactGraph(
  options: ReactLoopOptions,
  apiKey: string,
  failures: ConsecutiveFailureTracker,
) {
  /** 问一次模型。写出 finalText 表示该结束；finalText 为 null 表示带着 toolCalls 去执行。 */
  const askModel = async (state: ReactStateType) => {
    const ask = async () => {
      if (isLangSmithTracingEnabled()) {
        return traceAskModel({
          turn: state.turn,
          messages: state.messages,
          options,
          apiKey,
        });
      }
      const { choice } = await requestCompletion(state.messages, options, apiKey);
      return choice;
    };

    const choice = await ask();
    console.log(`\n=== ${state.turn}) 模型返回 ===`);
    console.log(JSON.stringify(choice, null, 2));

    const message = choice.message;
    if (!message) {
      return { finalText: "" };
    }

    const toolCalls = message.tool_calls;
    if (!toolCalls?.length) {
      const text = message.content ?? "";
      console.log(`\n=== ${state.turn}) 交给页面的文字 ===`);
      console.log(text);
      return { finalText: text };
    }

    if (state.turn === MAX_MODEL_TURNS) {
      const stopped = "这轮没做完：已达到询问次数上限。";
      console.log(`\n=== ${state.turn}) ${stopped} ===`);
      return { finalText: stopped };
    }

    return {
      finalText: null,
      toolCalls,
      assistantContent: message.content ?? null,
      assistantReasoningContent: message.reasoning_content ?? null,
    };
  };

  /** 先把 assistant+tool_calls 写入 messages，再执行并回填；turn+1 后回到 askModel。 */
  const applyTools = async (state: ReactStateType) => {
    const messages = [...state.messages];
    pushAssistantWithTools(
      messages,
      state.assistantContent,
      state.toolCalls,
      state.assistantReasoningContent,
    );
    // confirmSession / signal：人工确认用；未对接聊天时 session 为空，需确认工具安全降级
    await applyToolCalls(
      state.toolCalls,
      messages,
      options.onTrace,
      state.turn,
      failures,
      options.confirmSession,
      options.signal,
    );
    console.log(`\n=== ${state.turn}) 回填后的 messages ===`);
    console.log(JSON.stringify(messages, null, 2));
    return { messages, turn: state.turn + 1 };
  };

  /** 把 askModel 写下的 finalText 交给页面。
   * - searchDocs 打开时，先裁掉来源清单/检索元信息，避免像直接打印原文
   * - 然后再做系统提示词泄露检测
   */
  const reply = async (state: ReactStateType) => {
    const raw = state.finalText ?? "";
    const normalized = options.searchDocs ? normalizeKnowledgeAnswer(raw) : raw;
    const guard = detectLeakage(normalized);
    if (guard.leaked) {
      console.warn(`[OutputGuard] 检测到 system prompt 泄露，已替换。命中: ${guard.matchedFingerprints.join(", ")}`);
      options.onTrace?.({ type: "output_leak_blocked", matchedFingerprints: guard.matchedFingerprints });
    }
    options.onDelta(guard.safeText);
    return {};
  };

  /**
   * 下面这一串只是在「声明图」，还没跑。
   * 对应旧 for 循环：先问模型 → if 有工具就执行再问 → else 把文字交给页面然后 return。
   *
   * new StateGraph(ReactState)  声明状态长什么样（messages / turn / …）
   * addNode(名字, 函数)         登记一段可执行代码；名字给边用
   * addEdge(A, B)               A 跑完固定去 B（没有 if）
   * addConditionalEdges(A, fn)  A 跑完由 fn 看状态决定下一站（就是旧代码里的 if）
   * START / END                 图的入口和出口，不是业务节点
   * compile()                   把声明收成可 invoke 的对象；不 compile 不能跑
   */
  return new StateGraph(ReactState)
    // 三个业务步骤：问模型、跑工具、把文字交给页面
    .addNode("askModel", askModel)
    .addNode("applyTools", applyTools)
    .addNode("reply", reply)
    // 请求一开始先问模型。对应 for 循环第一行 requestCompletion
    .addEdge(START, "askModel")
    // 问完之后不能写死下一站：有 tool_calls 去 applyTools，否则去 reply。
    // 第三个参数是「函数返回值 → 节点名」；routeAfterAsk 返回的字符串必须能在这里找到。
    .addConditionalEdges("askModel", routeAfterAsk, {
      applyTools: "applyTools",
      reply: "reply",
    })
    // 工具跑完必须再问模型（看结果、决定还调不调）。对应 for 的下一轮。
    .addEdge("applyTools", "askModel")
    // 文字已经交给页面，没有下一站了。对应旧代码里的 return。
    .addEdge("reply", END)
    .compile();
}

/**
 * ReAct：问模型 → 有 tool_calls 则执行并回填再问 → 没有则把文字交给页面。
 * 行为与 `runConversation.forLoop.ts` 对齐，调度改由 LangGraph 按边走。
 */
export async function runConversation(options: ReactLoopOptions, apiKey: string) {
  const run = async () => {
    const failures = createConsecutiveFailureTracker();
    const messages: ProviderMessage[] = [...options.messages];
    const prefetch = await prefetchSearchDocsIfEnabled(messages, options, failures);
    if (prefetch.empty) {
      const msg = prefetch.emptyMessage ?? "资料里没有相关内容";
      const level = prefetch.isSystemError ? "error" : "info";
      console.log(`\n=== 0) 检索判空 [${level}]，不调 LLM，直接回复固定文案 ===`);
      options.onTrace?.({ type: "searchDocs_empty", level, message: msg });
      options.onDelta(msg);
      return;
    }
    const graph = compileReactGraph(options, apiKey, failures);
    // invoke = 按上面声明的边从头跑到 END。传入的对象是状态初值，对应旧循环开始前的局部变量。
    await graph.invoke({
      messages,
      turn: 1,
      toolCalls: [],
      assistantContent: null,
      assistantReasoningContent: null,
      finalText: null,
    });
  };

  if (isLangSmithTracingEnabled()) {
    await traceChatRequest({
      userPreview: lastUserPreview(options.messages),
      run,
    });
    return;
  }

  await run();
}
