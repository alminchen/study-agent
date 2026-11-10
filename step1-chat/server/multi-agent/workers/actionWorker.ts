/**
 * ActionWorker — 有后果动作（人工确认）。
 *
 * 工具集：仅 draft_message（学习用假发送）。
 * 执行路径：callLLM → runToolSafely（内含 wait/confirm）→ 再问模型。
 */

import { callLLM } from "../llm.js";
import { runToolSafely } from "../runToolSafely.js";
import { toolsWithTags } from "../../tools/index.js";
import { buildWorkerMessages } from "./memoryPrompt.js";
import type { WorkerContext, WorkerResult } from "./types.js";

const SYSTEM_PROMPT =
  "你是一个消息起草助手，只负责按用户要求起草并调用 draft_message 发送（模拟）。\n" +
  "可用工具：draft_message（to=收件人，body=正文）。\n" +
  "规则：\n" +
  "- 用户要求起草/发送/通知某人时，必须调用 draft_message\n" +
  "- 从任务里提取收件人和正文；缺信息就简短追问，不要编造无关内容\n" +
  "- 工具返回后，根据结果用一句话说明是否已模拟发送或被拒绝\n" +
  "- 不要回答天气、时间、知识库问题，那不是你的范围";

const MAX_TURNS = 3;

export async function runActionWorker(ctx: WorkerContext): Promise<WorkerResult> {
  const toolsCalled: string[] = [];
  const messages: {
    role: string;
    content: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }[] = buildWorkerMessages(SYSTEM_PROMPT, ctx.task, ctx.memoryBlock);

  const toolSchemas = toolsWithTags(["action"]).map((t) => t.schema);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await callLLM({
      messages,
      apiKey: ctx.apiKey,
      baseUrl: ctx.baseUrl,
      model: ctx.model,
      tools: toolSchemas as unknown[],
      signal: ctx.signal,
      onUsage: ctx.onUsage,
      traceSpan: { role: "worker", worker: "action", turn },
    });

    if (!result.ok) {
      return { worker: "action", output: "起草服务暂时不可用", toolsCalled, error: true };
    }

    if (result.toolCalls.length === 0) {
      return { worker: "action", output: result.content ?? "", toolsCalled, error: false };
    }

    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      toolsCalled.push(call.function.name);
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
  }

  return { worker: "action", output: "起草超时，请重试", toolsCalled, error: true };
}
