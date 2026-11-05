/**
 * 计划请求的观测收集器。
 *
 * 只做一件事：把「图里发生的事」压成步骤 11 要求的 13 个字段，
 * 供 /api/chat/plan 的日志行和 LangSmith 的 plan-request span 共用。
 *
 * 刻意不记录：完整 prompt、工具结果原文、用户消息全文。
 * 用户消息只保留短预览（与 chat-request 的 user_preview 同一约定）。
 */
import type { PlanObservation } from "../tracing/langsmith.js";
import type { PlanGraphState } from "./graph.js";
import type { PlanErrorCode, PlanEvent, PlanRouteReason, ResolvedMode } from "./types.js";

/** 用户消息短预览长度；与 chat-request 的 user_preview 对齐。 */
export const USER_PREVIEW_LIMIT = 120;

export interface PlanObserver {
  /** 计划事件出口：喂给 onEvent 的同时收集观测字段。 */
  onEvent: (event: PlanEvent) => void;
  /** 工具事件出口：只数工具调用次数，不留内容。事件类型比计划模式更宽（ReAct 回退会混入其它类型）。 */
  onTrace: (event: { type: string }) => void;
  /** 图跑完后汇总成一条观测记录。 */
  observe: (state: PlanGraphState) => PlanObservation;
}

export interface PlanObserverOptions {
  requestId: string;
  planId: string;
}

export function createPlanObserver(options: PlanObserverOptions): PlanObserver {
  const startedAt = Date.now();
  let mode: ResolvedMode | null = null;
  let reasonCode: PlanRouteReason | null = null;
  let revision = 0;
  let stepId: string | null = null;
  let toolCalls = 0;
  let plannerLatencyMs = 0;
  let errorCode: PlanErrorCode | null = null;
  let abortReason: string | null = null;

  return {
    onEvent(event: PlanEvent) {
      switch (event.type) {
        case "plan_route":
          mode = event.mode;
          reasonCode = event.reasonCode;
          break;
        case "plan_created":
          revision = event.revision;
          // 计划成形时间 = Planner + 校验耗时；规划慢是这类架构最常见的体感问题。
          plannerLatencyMs = Date.now() - startedAt;
          break;
        case "plan_replanned":
          revision = event.revision;
          break;
        case "plan_step_started":
          stepId = event.stepId;
          break;
        case "plan_step_failed":
          stepId = event.stepId || stepId;
          errorCode = event.code;
          break;
        case "plan_fallback":
          errorCode = event.reasonCode;
          break;
        case "plan_finished":
          if (event.status === "aborted") abortReason = "user_abort";
          break;
        default:
          break;
      }
    },
    onTrace(event: { type: string }) {
      if (event.type === "tool_call") toolCalls += 1;
    },
    observe(state: PlanGraphState): PlanObservation {
      if (state.terminalStatus === "aborted" && !abortReason) abortReason = "user_abort";
      return {
        requestId: options.requestId,
        planId: state.planRun?.planId ?? options.planId,
        revision: state.planRun?.revision ?? revision,
        mode: mode ?? (state.mode === "react" ? "react" : "plan"),
        reasonCode,
        stepId,
        modelCalls: state.modelCalls,
        toolCalls,
        replanCount: state.replanCount,
        plannerLatencyMs,
        totalLatencyMs: Date.now() - startedAt,
        abortReason,
        errorCode,
      };
    },
  };
}

/** 最后一条用户消息的短预览；日志和 span 都只拿这个。 */
export function planUserPreview(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content.trim().slice(0, USER_PREVIEW_LIMIT);
  }
  return "";
}
