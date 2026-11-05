/**
 * Plan-and-Execute 的共享协议。
 *
 * 两个层次刻意分开：
 * - Plan / PlanStep：模型产物，计划生成后不可变
 * - PlanRun / PlanStepResult：服务端运行时状态，不能信任模型自报
 */

export type PlanMode = "auto" | "react" | "plan";
export type ResolvedMode = "react" | "plan";

export type PlanToolName = "getWeather" | "getCurrentTime" | "searchDocs" | "draft_message";

export const PLAN_TOOL_NAMES: readonly PlanToolName[] = [
  "getWeather",
  "getCurrentTime",
  "searchDocs",
  "draft_message",
];

/**
 * 本次请求真正可用的计划工具。
 *
 * searchDocs 依赖知识库：没开启就不能出现在计划里，
 * 否则步骤执行时必然工具失败，把整份计划带崩。
 * 与 ReAct 侧 toolSchemasForChat(includeSearchDocs) 的约定保持一致。
 */
export function planAvailableTools(searchDocs: boolean): PlanToolName[] {
  return PLAN_TOOL_NAMES.filter((name) => searchDocs || name !== "searchDocs");
}

export interface PlanStep {
  id: string;
  title: string;
  action: string;
  doneWhen: string;
  tools: PlanToolName[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export type PlanErrorCode =
  | "classify_failed"
  | "planner_failed"
  | "invalid_plan"
  | "plan_empty"
  | "plan_too_long"
  | "step_turn_limit"
  | "step_tool_limit"
  | "tool_not_allowed"
  | "tool_failed"
  | "confirm_denied"
  | "replan_limit"
  | "model_budget_exhausted"
  | "aborted"
  | "final_reply_failed";

export type PlanRouteReason =
  | "explicit_react"
  | "explicit_plan"
  | "single_step"
  | "multi_capability"
  | "sequential_keywords"
  | "research_then_produce"
  | "artifact_request"
  | "too_ambiguous";

export interface ClassifyResult {
  mode: ResolvedMode;
  reasonCode: PlanRouteReason;
  signals: string[];
}

export type PlanStepStatus = "pending" | "running" | "done" | "failed" | "skipped" | "aborted";

export interface PlanStepResult {
  stepId: string;
  status: PlanStepStatus;
  summary: string;
  toolsCalled: string[];
  errorCode?: PlanErrorCode;
  startedAt: number;
  finishedAt?: number;
}

export type PlanRunStatus = "planning" | "running" | "replanned" | "completed" | "failed" | "aborted";

export interface PlanRun {
  planId: string;
  revision: number;
  mode: "plan";
  status: PlanRunStatus;
  plan: Plan;
  stepResults: PlanStepResult[];
  replanCount: number;
  modelCalls: number;
}

export interface PlanChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlanChatRequest {
  messages: PlanChatMessage[];
  model: string;
  mode?: PlanMode;
  searchDocs?: boolean;
}

/* ---------- SSE 事件契约（与前端 src/types.ts 保持一致） ----------
 *
 * 服务端与前端各存一份类型是刻意的：前端那份还兼作 SSE 反序列化后的
 * 运行时类型，两边靠这份契约对齐字段名，改一处必须同步另一处。
 */

export interface PlanRouteEvent {
  type: "plan_route";
  mode: ResolvedMode;
  reasonCode: PlanRouteReason;
  signals: string[];
}

export interface PlanCreatedEvent {
  type: "plan_created";
  planId: string;
  revision: number;
  plan: Plan;
}

export interface PlanStepStartedEvent {
  type: "plan_step_started";
  planId: string;
  revision: number;
  stepId: string;
  index: number;
  total: number;
}

export interface PlanStepDoneEvent {
  type: "plan_step_done";
  planId: string;
  revision: number;
  stepId: string;
  summary: string;
  toolsCalled: string[];
}

export interface PlanStepFailedEvent {
  type: "plan_step_failed";
  planId: string;
  revision: number;
  stepId: string;
  code: PlanErrorCode;
  message: string;
  retryable: boolean;
}

export interface PlanReplannedEvent {
  type: "plan_replanned";
  planId: string;
  previousRevision: number;
  revision: number;
  reason: string;
  plan: Plan;
}

export interface PlanFinishedEvent {
  type: "plan_finished";
  status: "completed" | "failed" | "aborted";
  completedSteps: number;
  totalSteps: number;
}

export interface PlanFallbackEvent {
  type: "plan_fallback";
  reasonCode: PlanErrorCode;
  message: string;
}

export type PlanEvent =
  | PlanRouteEvent
  | PlanCreatedEvent
  | PlanStepStartedEvent
  | PlanStepDoneEvent
  | PlanStepFailedEvent
  | PlanReplannedEvent
  | PlanFinishedEvent
  | PlanFallbackEvent;
