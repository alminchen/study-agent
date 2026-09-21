/**
 * 执行模型返回的 tool_calls，并把结果以 role:"tool" 回填进 messages。
 *
 * 普通工具：校验 → run → tool_result 事件 → push message
 * 需确认工具（isToolRequiringConfirm）：
 *   1. 发 pending_confirm（前端弹审阅）
 *   2. await ConfirmSession.wait
 *   3. allow → 真正 run；deny → { error: 用户拒绝 }，不 run
 *   4. 发 confirm_resolved，再发 tool_result
 *
 * 安全默认：需要确认但没传 confirmSession → 绝不 run，回填「未启用确认通道」。
 * （当前聊天未对接时即此行为；避免 draft_message 被误执行。）
 */

import { validateToolCall } from "../guard/toolCallGuard.js";
import { runToolWithTracing } from "../tracing/langsmith.js";
import type { ConfirmSession } from "./confirmGate.js";
import { isToolRequiringConfirm } from "./toolsRequiringConfirm.js";
import type { ConsecutiveFailureTracker } from "./toolFailure.js";
import type { ProviderMessage, ProviderToolCall, ToolTraceHandler } from "./types.js";

/** 工具结果必须带上这次调用的 id，模型和结果才能对上。 */
function toToolResultMessage(toolCallId: string, result: unknown): ProviderMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  };
}

/**
 * 真正跑工具。失败一律变成 `{ error }` 返回，不往外 throw。
 * 开启 LangSmith 时由 traceToolRun 包一层 tool span。
 */
async function runToolCall(call: ProviderToolCall, turn: number): Promise<unknown> {
  return runToolWithTracing(turn, call);
}

/** 结构化入参形态（若以后想改成单对象调用可用；现网仍用位置参数兼容 runConversation） */
export interface ApplyToolCallsOptions {
  toolCalls: ProviderToolCall[];
  messages: ProviderMessage[];
  onTrace?: ToolTraceHandler;
  turn: number;
  failures: ConsecutiveFailureTracker;
  /** 人工确认；未传则需确认工具直接回填错误、不执行 */
  confirmSession?: ConfirmSession;
  signal?: AbortSignal;
}

/**
 * 处理模型这一轮返回的全部 tool_calls。
 *
 * 一轮里可能有多个调用（例如天气+时间），按数组顺序逐个做完，
 * 再交回 runConversation 去问模型。
 *
 * @param confirmSession 聊天对接后传入；未传时需确认工具安全降级
 * @param signal 用户停止生成时打断 wait，避免 SSE 断了还挂着
 */
export async function applyToolCalls(
  toolCalls: ProviderToolCall[],
  messages: ProviderMessage[],
  onTrace: ToolTraceHandler | undefined,
  turn: number,
  failures: ConsecutiveFailureTracker,
  confirmSession?: ConfirmSession,
  signal?: AbortSignal,
) {
  for (const call of toolCalls) {
    // 面板上展示对象；解析失败仍用原始字符串，避免前端什么都看不到
    let parsedArgs: unknown = call.function.arguments;
    try {
      parsedArgs = JSON.parse(call.function.arguments);
    } catch {
      // 非法 JSON 交给工具自己的校验去返回 error
    }

    // 先告诉前端「模型要调谁」，确认类工具稍后还会追加 pending_confirm
    onTrace?.({
      type: "tool_call",
      name: call.function.name,
      arguments: parsedArgs,
    });

    let result: unknown;

    // ① Guard：白名单 / 参数长度 / JSON —— 不通过则根本不进入确认或 run
    const guard = validateToolCall(call.function.name, call.function.arguments);
    if (!guard.allowed) {
      console.warn(`[ToolCallGuard] 拒绝: ${guard.reason}`);
      result = { error: guard.reason };
    } else if (failures.isStopped(call.function.name)) {
      // ② 同一工具连续失败已达上限：不再 run，回填停止说明
      result = failures.stoppedResult(call.function.name);
    } else if (isToolRequiringConfirm(call.function.name)) {
      // ③ 有后果：确认闸门（可能长时间 await）
      result = await runWithOptionalConfirm({
        call,
        parsedArgs,
        turn,
        onTrace,
        confirmSession,
        signal,
      });
      failures.record(call.function.name, result);
    } else {
      // ④ 只读工具：立刻执行
      result = await runToolCall(call, turn);
      failures.record(call.function.name, result);
    }

    console.log(`\n=== ${turn}) 工具执行结果 ===`);
    console.log(JSON.stringify(result, null, 2));
    onTrace?.({
      type: "tool_result",
      name: call.function.name,
      result,
    });
    messages.push(toToolResultMessage(call.id, result));
  }
}

/**
 * 需确认工具的执行路径（从 applyToolCalls 拆出，避免主循环过长）。
 *
 * 分支：
 * - 无 session → 错误回填（当前阶段默认）
 * - 有 session → pending_confirm → wait → confirm_resolved → allow? run : 拒绝错误
 */
async function runWithOptionalConfirm(input: {
  call: ProviderToolCall;
  parsedArgs: unknown;
  turn: number;
  onTrace?: ToolTraceHandler;
  confirmSession?: ConfirmSession;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { call, parsedArgs, turn, onTrace, confirmSession, signal } = input;

  if (!confirmSession) {
    console.warn(`[Confirm] ${call.function.name} 需要确认，但当前请求未传入 ConfirmSession`);
    return { error: "该工具需要人工确认，当前请求未启用确认通道" };
  }

  // 前端凭 confirmId + toolCallId 调 POST /api/chat/confirm
  onTrace?.({
    type: "pending_confirm",
    confirmId: confirmSession.confirmId,
    toolCallId: call.id,
    name: call.function.name,
    arguments: parsedArgs,
  });

  let action: "allow" | "deny";
  try {
    action = await confirmSession.wait(call.id, call.function.name, parsedArgs, signal);
    console.log('action wait :>> ', action);
  } catch (error) {
    // abort / dispose 竞态：不当成「已发送」，只回填错误让模型改口
    const message = error instanceof Error ? error.message : "确认等待失败";
    return { error: message };
  }

  onTrace?.({
    type: "confirm_resolved",
    toolCallId: call.id,
    name: call.function.name,
    action,
  });

  if (action === "deny") {
    // 关键：拒绝 = 不调用 run*，只回填错误字符串给模型
    return { error: "用户拒绝执行该操作" };
  }

  return runToolCall(call, turn);
}
