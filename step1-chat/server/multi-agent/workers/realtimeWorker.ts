/**
 * RealtimeWorker — 处理需要实时数据的查询（天气、时间）。
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │ 职责边界                                                 │
 * │ - 天气查询（getWeather）                                │
 * │ - 时间查询（getCurrentTime）                            │
 * │ - 其他问题一律拒绝："这不是我负责的范围"                │
 * └─────────────────────────────────────────────────────────┘
 *
 * 工具集：getWeather + getCurrentTime（只有这两个，模型看不到 searchDocs）
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
 *                    │ 执行工具     │          │ 返回回复文本│         │
 *                    │ 结果回填     │          └────────────┘         │
 *                    └──────┬──────┘                                  │
 *                           │                                        │
 *                           └────── 下一轮（最多 3 轮）───────────────┘
 *
 * 最多循环 MAX_TURNS=3 轮，防止模型反复调工具不收敛。
 * 达到上限仍未产出最终回复 → 返回错误。
 */

import { callLLM } from "../llm.js";
import { runToolSafely } from "../runToolSafely.js";
import { toolsWithTags } from "../../tools/index.js";
import { buildWorkerMessages } from "./memoryPrompt.js";
import type { WorkerContext, WorkerResult } from "./types.js";

/**
 * RealtimeWorker 专属 system prompt。
 * 设计要点：
 * - 开头声明"只负责天气和时间"，划清能力边界
 * - 列出可用工具及使用规则
 * - 明确拒绝非职责范围的问题（避免越界回答）
 */
const SYSTEM_PROMPT =
  "你是一个实时数据查询助手，只负责回答天气和时间相关问题。\n" +
  "可用工具：getWeather（查城市天气）、getCurrentTime（查当前时间）。\n" +
  "规则：\n" +
  "- 问天气 → 调 getWeather，city 填城市名\n" +
  "- 问时间/几点/今天几号 → 调 getCurrentTime\n" +
  "- 含「今天」「今日」「当前」等时间词的天气问题 → 两个工具都调（先 getCurrentTime 拿日期，再 getWeather 拿天气），回复时带上日期\n" +
  "- 拿到工具结果后，用简洁的自然语言回复\n" +
  "- 不要回答与天气/时间无关的问题，直接说「这不是我负责的范围」";

/** 最大 ReAct 循环轮次。天气/时间最多调 2 个工具，3 轮绰绰有余。 */
const MAX_TURNS = 3;

/**
 * 执行 RealtimeWorker 的 mini ReAct 循环。
 *
 * @param ctx Supervisor 传入的上下文（task 是 Supervisor 提取的子任务，如"广州天气"）
 * @returns WorkerResult 包含最终回复和工具调用记录
 *
 * 示例：
 *   输入: ctx.task = "广州天气"
 *   过程: 模型调用 getWeather("广州") → 拿到结果 → 组织回复
 *   输出: { worker:"realtime", output:"广州当前25°C，多云", toolsCalled:["getWeather"], error:false }
 */
export async function runRealtimeWorker(ctx: WorkerContext): Promise<WorkerResult> {
  /** 记录本次执行中调用了哪些工具（按顺序） */
  const toolsCalled: string[] = [];

  /**
   * Worker 自己的消息列表（独立于主对话历史）。
   * 只包含：system prompt + Supervisor 分配的 task(作为 user) + 工具交互过程。
   * 这保证了 Worker 的上下文干净，不会被其他 Worker 或主对话污染。
   */
  const messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] =
    buildWorkerMessages(SYSTEM_PROMPT, ctx.task, ctx.memoryBlock);

  /**
   * 只暴露 getWeather 和 getCurrentTime 的 schema 给模型。
   * 这是"工具隔离"的关键：模型看不到 searchDocs，自然不会调用它。
   */
  const toolSchemas = toolsWithTags(["realtime"]).map((t) => t.schema);

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
      traceSpan: { role: "worker", worker: "realtime", turn },
    });

    // LLM 调用失败 → 返回错误，Aggregate 会标注"部分信息获取失败"
    if (!result.ok) {
      return { worker: "realtime", output: "实时查询服务暂时不可用", toolsCalled, error: true };
    }

    // --- 步骤 B：判断模型是否要调工具 ---

    // 没有 tool_calls → 模型认为信息已充分，给出了最终回复
    if (result.toolCalls.length === 0) {
      return { worker: "realtime", output: result.content ?? "", toolsCalled, error: false };
    }

    // --- 步骤 C：有 tool_calls → 执行工具，把结果回填到消息列表 ---

    // 先把 assistant 的 tool_calls 消息加入历史（模型需要看到自己之前请求了什么）
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

    // 逐个执行工具（经 toolCallGuard 白名单校验）
    for (const call of result.toolCalls) {
      toolsCalled.push(call.function.name);

      const toolResult = await runToolSafely(call.function.name, call.function.arguments, {
        toolCallId: call.id,
        confirmSession: ctx.confirmSession,
        onTrace: ctx.onTrace,
        signal: ctx.signal,
        turn,
      });

      // 工具结果以 role:"tool" 回填，tool_call_id 用于和 assistant 的请求对应
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult),
        tool_call_id: call.id,
      });
    }
    // 回到循环顶部，带着工具结果再问模型 → 模型看到结果后应该能给出最终回复
  }

  // 达到最大轮次仍未收敛（极少见，3 轮内 2 个工具肯定够了）
  return { worker: "realtime", output: "查询超时，请重试", toolsCalled, error: true };
}
