/**
 * Plan-and-Execute 主图（纯函数状态机 + 显式事件序列）。
 *
 * 节点：classify → plan → execute(逐步) → finalReply → finished
 * 分支：classify=react 直接走 ReAct；计划非法只回退 ReAct 一次。
 *
 * 为什么不引入 LangGraph：这张图只有一条主链和一个回退分支，
 * 顺序事件数组让「事件顺序可预测」「状态转换可断言」变得直接，
 * 也避免为一个线性流程引入额外状态合并语义。
 *
 * 不变量：
 * - 简单任务（classify=react）不调用 Planner。
 * - 复杂任务先推 plan_created，再进第一步。
 * - 每一步都有 started，并以 done / failed / aborted 收尾。
 * - 计划非法只回退一次，不重试第二次 Planner。
 * - 模型调用达到预算后不再执行下一步。
 * - Re-plan 属于步骤 7：这里失败即终止，不自造重规划。
 */
import { createConsecutiveFailureTracker } from "../react/toolFailure.js";
import { classifyTask } from "./classify.js";
import type { ReactFallbackRunner, StepExecutor } from "./executor.js";
import type { FinalReplier } from "./finalReply.js";
import type { Planner, PlanContext } from "./planner.js";
import {
  decideReplan,
  MAX_REPLAN,
  REPLAN_MODEL_COST,
  validateReplanCandidate,
  type Replanner,
} from "./replan.js";
import { MAX_PLAN_STEPS, validatePlan } from "./schema.js";
import { planAvailableTools } from "./types.js";
import type {
  ClassifyResult,
  Plan,
  PlanChatMessage,
  PlanErrorCode,
  PlanEvent,
  PlanMode,
  PlanRun,
  PlanRunStatus,
  PlanStep,
  PlanStepResult,
} from "./types.js";

/**
 * 工具过程事件的最小结构。
 * 刻意只声明计划模式真正会转发的那几种，不去动 react 模块的类型定义。
 */
export type PlanTraceEvent =
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | {
      type: "pending_confirm";
      confirmId: string;
      toolCallId: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "confirm_resolved";
      toolCallId: string;
      name: string;
      action: "allow" | "deny";
    };

/** 计划模式会转发给前端的工具事件类型；其余（如 searchDocs_empty）留在 react 侧。 */
const PLAN_TRACE_TYPES = new Set([
  "tool_call",
  "tool_result",
  "pending_confirm",
  "confirm_resolved",
]);

/** 整任务模型调用上限（含 Planner、Executor、最终回答；步骤 7 的 Re-plan 也从这里扣）。 */
export const MAX_MODEL_CALLS = 15;
export { MAX_REPLAN };

/**
 * 单个节点最多花掉几次模型调用。
 * Executor 内部最多 2 轮（工具轮 + 结果总结），这里按上限预留，
 * 宁可提前停，也不让实际调用数越过整任务预算。
 */
const PLANNER_MODEL_COST = 1;
const STEP_MODEL_COST = 2;
const FINAL_REPLY_MODEL_COST = 1;

/** 图状态：文档要求的 10 个字段，外加 planId 便于日志关联。 */
export interface PlanGraphState {
  messages: PlanChatMessage[];
  mode: PlanMode;
  classifyResult: ClassifyResult | null;
  planRun: PlanRun | null;
  currentStepIndex: number;
  stepResults: PlanStepResult[];
  replanCount: number;
  modelCalls: number;
  finalText: string;
  terminalStatus: PlanRunStatus;
}

export interface RunPlanGraphOptions {
  messages: PlanChatMessage[];
  model: string;
  apiKey: string;
  mode?: PlanMode;
  searchDocs?: boolean;
  confirmSession?: import("../react/confirmGate.js").ConfirmSession;
  signal?: AbortSignal;
  planner: Planner;
  executor: StepExecutor;
  finalReplier: FinalReplier;
  /** 可选：未注入时步骤失败即终止（步骤 6 行为）。 */
  replanner?: Replanner;
  /** ReAct 兜底：classify=react 与计划非法时都走这里。 */
  reactFallback: ReactFallbackRunner;
  /** 计划事件（plan_*）出口；前端据此渲染计划时间线。 */
  onEvent: (event: PlanEvent) => void;
  /** 工具过程事件（tool_call / pending_confirm 等）出口；与计划事件分开，避免混流。 */
  onTrace?: (event: PlanTraceEvent) => void;
  /** 最终回答的文字出口；计划模式下只有最后一步会写这里。 */
  onDelta: (delta: string) => void;
  planId?: string;
  /** 测试用：缩小整任务模型预算。 */
  maxModelCalls?: number;
}

function lastUserMessage(messages: PlanChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

export function stepDoneCount(stepResults: PlanStepResult[]): number {
  return stepResults.filter((result) => result.status === "done").length;
}

export async function runPlanGraph(options: RunPlanGraphOptions): Promise<PlanGraphState> {
  const { onEvent, onDelta, signal } = options;
  const planId = options.planId ?? `plan_${Date.now().toString(36)}`;
  const userMessage = lastUserMessage(options.messages);
  const maxModelCalls = options.maxModelCalls ?? MAX_MODEL_CALLS;
  /** 本次真正可用的工具；知识库没开时 searchDocs 不在其中。 */
  const availableTools = planAvailableTools(options.searchDocs === true);
  const failures = createConsecutiveFailureTracker();

  const state: PlanGraphState = {
    messages: options.messages,
    mode: options.mode ?? "auto",
    classifyResult: null,
    planRun: null,
    currentStepIndex: 0,
    stepResults: [],
    replanCount: 0,
    modelCalls: 0,
    finalText: "",
    terminalStatus: "planning",
  };

  /** 预算只按节点上限预留，实际调用数由各节点自行控制在预留值以内。 */
  const canSpend = (cost: number) => state.modelCalls + cost <= maxModelCalls;
  const spend = (cost: number) => {
    state.modelCalls += cost;
  };

  const totalSteps = () => state.planRun?.plan.steps.length ?? 0;

  const syncPlanRun = (status?: PlanRunStatus) => {
    if (!state.planRun) return;
    state.planRun.stepResults = state.stepResults;
    state.planRun.modelCalls = state.modelCalls;
    state.planRun.replanCount = state.replanCount;
    if (status) state.planRun.status = status;
  };

  const finish = (status: "completed" | "failed" | "aborted") => {
    state.terminalStatus = status;
    syncPlanRun(status);
    onEvent({
      type: "plan_finished",
      status,
      completedSteps: stepDoneCount(state.stepResults),
      totalSteps: totalSteps(),
    });
  };

  /** 非步骤级的失败（规划预算耗尽、最终回答失败等）也要让前端收到明确终态。 */
  const failWithoutStep = (code: PlanErrorCode, message: string) => {
    onEvent({
      type: "plan_step_failed",
      planId,
      revision: state.planRun?.revision ?? 0,
      stepId: "",
      code,
      message,
      retryable: false,
    });
    finish("failed");
  };

  // ① 分类：简单任务不进 Planner，直接 ReAct。
  const classifyResult = classifyTask({
    userMessage,
    mode: options.mode,
    searchDocs: options.searchDocs,
  });
  state.classifyResult = classifyResult;
  state.mode = classifyResult.mode;
  onEvent({
    type: "plan_route",
    mode: classifyResult.mode,
    reasonCode: classifyResult.reasonCode,
    signals: classifyResult.signals,
  });

  if (classifyResult.mode === "react") {
    await options.reactFallback.run();
    state.terminalStatus = "completed";
    return state;
  }

  const fallbackToReact = async (reasonCode: PlanErrorCode, message: string) => {
    onEvent({
      type: "plan_fallback",
      reasonCode,
      message: `${message}；已回退到 ReAct 直接执行`,
    });
    await options.reactFallback.run();
    state.terminalStatus = "completed";
    return state;
  };

  // ② 规划：只尝试一次，失败即回退 ReAct（不重试第二次 Planner）。
  if (signal?.aborted) {
    finish("aborted");
    return state;
  }
  if (!canSpend(PLANNER_MODEL_COST)) {
    failWithoutStep("model_budget_exhausted", "模型调用预算不足，无法生成计划");
    return state;
  }
  spend(PLANNER_MODEL_COST);

  const planContext: PlanContext = {
    userMessage,
    history: options.messages,
    model: options.model,
    searchDocs: options.searchDocs ?? false,
    revision: 0,
    planId,
  };
  const planned = await options.planner.plan(planContext);
  if (planned.kind === "fallback") {
    return fallbackToReact(planned.reasonCode, planned.message);
  }

  // 图这一层再校验一次：MockPlanner 或模型直出的计划也可能不合法。
  const validation = validatePlan(planned.plan, {
    requireSearchDocs: options.searchDocs,
    availableTools,
  });
  if (!validation.ok) {
    return fallbackToReact(validation.code, validation.message);
  }

  let activePlan = validation.plan;
  let revision = 0;
  state.planRun = {
    planId,
    revision,
    mode: "plan",
    status: "running",
    plan: activePlan,
    stepResults: [],
    replanCount: 0,
    modelCalls: state.modelCalls,
  };
  onEvent({ type: "plan_created", planId, revision, plan: activePlan });

  // ③ 逐步执行：一次只做一步；可恢复失败先尝试一次受控 Re-plan，其余一律终止。
  let cursor = 0;
  while (cursor < activePlan.steps.length) {
    if (signal?.aborted) {
      finish("aborted");
      return state;
    }

    const step = activePlan.steps[cursor]!;
    state.currentStepIndex = cursor;

    if (!canSpend(STEP_MODEL_COST)) {
      onEvent({
        type: "plan_step_failed",
        planId,
        revision,
        stepId: step.id,
        code: "model_budget_exhausted",
        message: "模型调用预算已耗尽，停止执行后续步骤",
        retryable: false,
      });
      finish("failed");
      return state;
    }

    onEvent({
      type: "plan_step_started",
      planId,
      revision,
      stepId: step.id,
      index: cursor,
      total: activePlan.steps.length,
    });
    spend(STEP_MODEL_COST);

    const result = await options.executor.runStep({
      plan: activePlan,
      step,
      index: cursor,
      planId,
      revision,
      model: options.model,
      apiKey: options.apiKey,
      confirmSession: options.confirmSession,
      failures,
      completedSummaries: state.stepResults
        .filter((item) => item.status === "done")
        .map((item) => item.summary),
      // Executor 的 onTrace 类型更宽（含 searchDocs/degradation 等非计划事件）；
      // 这里只转发计划模式关心的几种。
      onTrace: (event) => {
        if (PLAN_TRACE_TYPES.has(event.type)) {
          options.onTrace?.(event as PlanTraceEvent);
        }
      },
      signal,
    });

    state.stepResults = [...state.stepResults, result];
    syncPlanRun();

    if (result.status === "done") {
      onEvent({
        type: "plan_step_done",
        planId,
        revision,
        stepId: result.stepId,
        summary: result.summary,
        toolsCalled: result.toolsCalled,
      });
      cursor += 1;
      continue;
    }

    if (result.status === "aborted") {
      finish("aborted");
      return state;
    }

    const errorCode = result.errorCode ?? "tool_failed";
    const decision = decideReplan({
      errorCode,
      replanCount: state.replanCount,
      remainingModelCalls: maxModelCalls - state.modelCalls,
      aborted: signal?.aborted ?? false,
    });
    const willReplan = Boolean(options.replanner) && decision.allowed;

    onEvent({
      type: "plan_step_failed",
      planId,
      revision,
      stepId: result.stepId,
      code: errorCode,
      message: result.summary,
      retryable: willReplan,
    });

    if (!willReplan || !decision.allowed || !options.replanner) {
      finish("failed");
      return state;
    }

    // ④ 受控 Re-plan：新旧计划并存，已完成步骤原样保留，只从失败处继续。
    spend(REPLAN_MODEL_COST);
    const completedSteps = state.stepResults
      .filter((item) => item.status === "done")
      .map((item) => {
        const doneStep = activePlan.steps.find((candidate) => candidate.id === item.stepId);
        return doneStep ? { step: doneStep, summary: item.summary } : null;
      })
      .filter((item): item is { step: PlanStep; summary: string } => item !== null);

    const remainingAfterReplan = maxModelCalls - state.modelCalls;
    const maxNewSteps = Math.floor(
      Math.max(0, remainingAfterReplan - FINAL_REPLY_MODEL_COST) / STEP_MODEL_COST,
    );
    const maxSteps = Math.min(MAX_PLAN_STEPS, completedSteps.length + maxNewSteps);

    const outcome = await options.replanner.replan({
      planId,
      goal: activePlan.goal,
      previousPlan: activePlan,
      revision,
      completedSteps,
      failedStep: step,
      errorCode,
      reason: decision.reason,
      maxSteps,
      remainingModelCalls: remainingAfterReplan,
      blockedActions: state.stepResults
        .filter((item) => item.errorCode === "confirm_denied")
        .map((item) => item.summary),
      searchDocs: options.searchDocs === true,
      model: options.model,
    });

    const rejected: { code: PlanErrorCode; message: string } | null =
      outcome.kind === "rejected" ? outcome : null;
    if (rejected) {
      // 计划级失败（stepId 为空）：不能覆盖步骤上已经写好的根因，
      // 否则用户只看到「Re-plan 被拒」，看不到最初为什么失败。
      onEvent({
        type: "plan_step_failed",
        planId,
        revision,
        stepId: "",
        code: rejected.code,
        message: `Re-plan 未被采纳：${rejected.message}`,
        retryable: false,
      });
      finish("failed");
      return state;
    }
    if (outcome.kind !== "replanned") {
      finish("failed");
      return state;
    }

    const checked = validateReplanCandidate(outcome.plan, {
      previousPlan: activePlan,
      completedCount: completedSteps.length,
      maxSteps,
      availableTools,
    });
    if (!checked.ok) {
      onEvent({
        type: "plan_step_failed",
        planId,
        revision,
        stepId: "",
        code: checked.code,
        message: `Re-plan 未被采纳：${checked.message}`,
        retryable: false,
      });
      finish("failed");
      return state;
    }

    const previousRevision = revision;
    revision = outcome.revision;
    state.replanCount += 1;
    activePlan = checked.plan;
    state.planRun = {
      planId,
      revision,
      mode: "plan",
      status: "replanned",
      plan: activePlan,
      stepResults: state.stepResults,
      replanCount: state.replanCount,
      modelCalls: state.modelCalls,
    };
    onEvent({
      type: "plan_replanned",
      planId,
      previousRevision,
      revision,
      reason: `${outcome.note}（${outcome.reason}）`,
      plan: activePlan,
    });
    cursor = completedSteps.length;
  }

  // ⑤ 最终回答：只引用真实执行过的步骤。
  if (signal?.aborted) {
    finish("aborted");
    return state;
  }
  if (!canSpend(FINAL_REPLY_MODEL_COST)) {
    failWithoutStep("model_budget_exhausted", "模型调用预算已耗尽，无法生成最终回答");
    return state;
  }
  spend(FINAL_REPLY_MODEL_COST);

  const reply = await options.finalReplier.reply({
    goal: activePlan.goal,
    plan: activePlan,
    stepResults: state.stepResults,
    model: options.model,
  });
  if (reply.kind === "failed") {
    failWithoutStep("final_reply_failed", reply.message);
    return state;
  }

  state.finalText = reply.text;
  onDelta(reply.text);
  finish("completed");
  return state;
}
