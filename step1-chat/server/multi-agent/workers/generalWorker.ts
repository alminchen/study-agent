/**
 * GeneralWorker — 兜底闲聊 Worker，无工具。
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │ 职责边界                                                 │
 * │ - 回答不属于天气/时间/知识库的一般问题                  │
 * │ - 如编程问题、概念解释、闲聊等                          │
 * │ - 无任何工具，纯靠模型知识回答                          │
 * └─────────────────────────────────────────────────────────┘
 *
 * 工具集：无（模型只能凭自身知识回答）
 *
 * 与其他 Worker 的区别：
 * - RealtimeWorker / KBWorker 有工具 + ReAct 循环
 * - GeneralWorker 没有工具，所以不需要循环，只做一次 LLM 调用
 *
 * 内部流程（单次调用）：
 *
 *   ┌──────────┐     ┌──────────────────┐     ┌──────────────┐
 *   │ task 输入 │────►│ 问模型(无工具)    │────►│ 返回回复文本  │
 *   └──────────┘     └──────────────────┘     └──────────────┘
 *
 * 这是最简单的 Worker，本质就是一次普通的 Chat Completion。
 */

import { callLLM } from "../llm.js";
import type { WorkerContext, WorkerResult } from "./types.js";

/**
 * GeneralWorker 专属 system prompt。
 * 设计要点：
 * - 定位为前端开发者助手（与主 system prompt 保持人设一致）
 * - 明确告知"没有工具可用"，避免模型幻想自己能调工具
 * - 简洁准确，不要废话
 */
const SYSTEM_PROMPT =
  "你是一个面向前端开发者的 AI 助手。\n" +
  "回答尽量简洁、准确、贴近实践。\n" +
  "你没有任何工具可用，只能凭知识回答。";

/**
 * 执行 GeneralWorker：一次 LLM 调用，无工具，无循环。
 *
 * @param ctx Supervisor 传入的上下文（task 是 Supervisor 分配的问题）
 * @returns WorkerResult 包含纯聊天回复
 *
 * 示例：
 *   输入: ctx.task = "Vue 3 的 ref 和 reactive 有什么区别"
 *   过程: 直接问模型
 *   输出: { worker:"general", output:"ref 用于基本类型...", toolsCalled:[], error:false }
 */
export async function runGeneralWorker(ctx: WorkerContext): Promise<WorkerResult> {
  // 单次 LLM 调用，不传 tools（模型不会产生 tool_calls）
  const result = await callLLM({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: ctx.task },
    ],
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    model: ctx.model,
    signal: ctx.signal,
    onUsage: ctx.onUsage,
    traceSpan: { role: "worker", worker: "general" },
  });

  // LLM 调用失败
  if (!result.ok) {
    return { worker: "general", output: "服务暂时不可用，请稍后重试", toolsCalled: [], error: true };
  }

  return { worker: "general", output: result.content ?? "", toolsCalled: [], error: false };
}
