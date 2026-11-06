/**
 * Worker 执行工具：Guard →（可选）人工确认 → run。
 * 确认语义对齐单 Agent applyToolCalls / runWithOptionalConfirm。
 * 实际执行走 `runToolWithTracing`，与单 Agent 共用 LangSmith tool span。
 */

import { validateToolCall } from "../guard/toolCallGuard.js";
import { isToolRequiringConfirm } from "../tools/index.js";
import type { ConfirmSession } from "../react/confirmGate.js";
import type { ToolTraceHandler } from "../react/types.js";
import { findTool } from "../tools/index.js";
import { runToolWithTracing } from "../tracing/langsmith.js";

export interface RunToolSafelyOptions {
  /** 模型返回的 tool_call.id，确认 API 用同一个键 */
  toolCallId: string;
  confirmSession?: ConfirmSession;
  onTrace?: ToolTraceHandler;
  signal?: AbortSignal;
  /** Worker 内 ReAct 轮次（供 LangSmith tool span 的 turn 字段） */
  turn?: number;
}

export async function runToolSafely(
  name: string,
  rawArguments: string,
  options: RunToolSafelyOptions,
): Promise<unknown> {
  const { toolCallId, confirmSession, onTrace, signal, turn = 0 } = options;

  let parsedArgs: unknown = rawArguments;
  try {
    parsedArgs = JSON.parse(rawArguments);
  } catch {
    // 非法 JSON 交给 Guard / 工具自己处理
  }

  onTrace?.({ type: "tool_call", name, arguments: parsedArgs });

  const guard = validateToolCall(name, rawArguments);
  if (!guard.allowed) {
    console.warn(`[ToolCallGuard] multi-agent 拒绝: ${guard.reason}`);
    const result = { error: guard.reason };
    onTrace?.({ type: "tool_result", name, result });
    return result;
  }

  if (!findTool(name)) {
    const result = { error: `未知工具: ${name}` };
    onTrace?.({ type: "tool_result", name, result });
    return result;
  }

  let result: unknown;

  /** 真实执行走与单 Agent 相同的 LangSmith tool span（含错误转 { error }） */
  const executeTraced = () =>
    runToolWithTracing(turn, {
      id: toolCallId,
      type: "function",
      function: { name, arguments: rawArguments },
    });

  if (isToolRequiringConfirm(name)) {
    if (!confirmSession) {
      console.warn(`[Confirm] multi ${name} 需要确认，但未传入 ConfirmSession`);
      result = { error: "该工具需要人工确认，当前请求未启用确认通道" };
    } else {
      onTrace?.({
        type: "pending_confirm",
        confirmId: confirmSession.confirmId,
        toolCallId,
        name,
        arguments: parsedArgs,
      });

      let action: "allow" | "deny";
      try {
        action = await confirmSession.wait(toolCallId, name, parsedArgs, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "确认等待失败";
        result = { error: message };
        onTrace?.({ type: "tool_result", name, result });
        return result;
      }

      onTrace?.({
        type: "confirm_resolved",
        toolCallId,
        name,
        action,
      });

      if (action === "deny") {
        result = { error: "用户拒绝执行该操作" };
      } else {
        // allow 之后才打 LangSmith tool span（与单 Agent 一致：只观测真实执行）
        result = await executeTraced();
      }
    }
  } else {
    result = await executeTraced();
  }

  onTrace?.({ type: "tool_result", name, result });
  return result;
}
