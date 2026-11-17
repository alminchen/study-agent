/**
 * KBWorker — 处理知识库/笔记/资料搜索问题。
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │ 职责边界                                                 │
 * │ - 基于知识库内容回答用户问题                            │
 * │ - 标注引用来源编号 [n]                                  │
 * │ - 检索无结果时如实告知，绝对不编造                      │
 * │ - 其他问题一律拒绝："这不是我负责的范围"                │
 * └─────────────────────────────────────────────────────────┘
 *
 * 工具集：searchDocs（只有这一个，模型看不到 getWeather/getCurrentTime）
 *
 * 内部流程（mini ReAct 循环）：
 *
 *   ┌──────────┐     ┌─────────────────┐     ┌──────────────┐
 *   │ task 输入 │────►│ 问模型(带工具)   │────►│ 有 tool_calls?│
 *   └──────────┘     └─────────────────┘     └──────┬───────┘
 *                                                    │
 *                           ┌────────────────────────┼────────────────┐
 *                           │ 是                     │ 否              │
 *                           ▼                        ▼                │
 *                    ┌─────────────┐          ┌────────────┐         │
 *                    │ searchDocs   │          │ 返回回复文本│         │
 *                    │ 结果回填     │          └────────────┘         │
 *                    └──────┬──────┘                                  │
 *                           │                                        │
 *                           └────── 下一轮（最多 3 轮）───────────────┘
 *
 * 与单 Agent 模式下 prefetchSearchDocs 的区别：
 * - prefetchSearchDocs：单 Agent 模式的"强制先检索再进 ReAct"
 * - KBWorker：多 Agent 模式下由 Supervisor 按需调度的独立检索 Agent
 * - 两者底层都用 executeSearchDocs（同一套 RAG 管线），但控制流不同
 */

import { callLLM } from "../llm.js";
import { runToolSafely } from "../runToolSafely.js";
import { toolsWithTags } from "../../tools/index.js";
import { buildWorkerMessages } from "./memoryPrompt.js";
import type { WorkerContext, WorkerResult } from "./types.js";

/**
 * KBWorker 专属 system prompt。
 * 设计要点：
 * - 强调"基于检索结果回答"，不允许编造
 * - 要求标注来源编号，方便用户溯源
 * - 检索无结果时如实说，不要硬编一个答案
 */
const SYSTEM_PROMPT =
  "你是一个知识库问答助手，只负责基于用户笔记/资料回答问题。\n" +
  "可用工具：searchDocs（搜索知识库）。\n" +
  "规则：\n" +
  "- 收到问题后，先调用 searchDocs 检索\n" +
  "- 基于检索结果回答，标注来源编号 [n]\n" +
  "- 如果检索无结果，如实说「资料里没有相关内容」\n" +
  "- 绝对不要编造文档名、章节号或引用\n" +
  "- 不要回答与知识库无关的问题，直接说「这不是我负责的范围」";

/** 最大 ReAct 循环轮次。知识库通常一次 searchDocs 就够，3 轮是安全余量。 */
const MAX_TURNS = 3;

/**
 * 执行 KBWorker 的 mini ReAct 循环。
 *
 * @param ctx Supervisor 传入的上下文（task 是 Supervisor 提取的子任务，如"出行建议"）
 * @returns WorkerResult 包含基于知识库的回复
 *
 * 示例：
 *   输入: ctx.task = "出行建议"
 *   过程: 模型调用 searchDocs("出行建议") → 拿到知识库命中 → 组织回复
 *   输出: { worker:"kb", output:"根据你的笔记[1]，建议...", toolsCalled:["searchDocs"], error:false }
 */
export async function runKBWorker(ctx: WorkerContext): Promise<WorkerResult> {
  /** 记录本次执行中调用了哪些工具 */
  const toolsCalled: string[] = [];

  /**
   * Worker 自己的消息列表（独立于主对话历史）。
   * 只包含 system + task + 工具交互，保证上下文干净。
   */
  const messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] =
    buildWorkerMessages(SYSTEM_PROMPT, ctx.task, ctx.memoryBlock, ctx.historyMessages, ctx.contextSummary);

  /**
   * 只暴露 searchDocs 的 schema 给模型。
   * 工具隔离：模型看不到 getWeather/getCurrentTime，不会误调。
   */
  const toolSchemas = toolsWithTags(["kb"]).map((t) => t.schema);

  // === mini ReAct 循环 ===
  for (let turn = 0; turn < MAX_TURNS; turn++) {

    // --- 步骤 A：问模型（通过公共 callLLM）---
    const result = await callLLM({
      messages,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      tools: toolSchemas as unknown[],
      signal: ctx.signal,
      onUsage: ctx.onUsage,
      traceSpan: { role: "worker", worker: "kb", turn },
    });

    if (!result.ok) {
      return { worker: "kb", output: "知识库查询服务暂时不可用", toolsCalled, error: true };
    }

    // --- 步骤 B：判断是否有 tool_calls ---

    // 没有 tool_calls → 模型已经给出最终回复
    if (result.toolCalls.length === 0) {
      return { worker: "kb", output: result.content ?? "", toolsCalled, error: false };
    }

    // --- 步骤 C：执行工具，结果回填 ---

    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    for (const call of result.toolCalls) {
      toolsCalled.push(call.function.name);

      // 经 toolCallGuard；通过后执行 searchDocs → retrieveForAnswer
      const toolResult = await runToolSafely(call.function.name, call.function.arguments, {
        toolCallId: call.id,
        confirmSession: ctx.confirmSession,
        onTrace: ctx.onTrace,
        signal: ctx.signal,
        turn,
      });

      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        tool_call_id: call.id,
      });
    }
    // 带着检索结果再问模型 → 模型基于结果组织回复
  }

  // 达到最大轮次（极少见）
  return { worker: "kb", output: "知识库查询超时，请重试", toolsCalled, error: true };
}
