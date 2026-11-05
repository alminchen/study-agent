/**
 * 受控 Re-plan：只修计划，不改已经发生的事实。
 *
 * 三条硬边界：
 * - 只有可恢复的步骤失败才允许重规划；确认拒绝、中止、安全拦截一律不重规划。
 * - 最多一次；旧计划按引用保留，新版本写入新 revision，不覆盖历史。
 * - 已完成步骤必须原样保留，新计划步数受剩余模型预算约束。
 */
import { requestCompletion } from "../react/complete.js";
import type { TextMessage } from "../react/types.js";
import { runPlanPlannerWithTracing } from "../tracing/langsmith.js";
import { createEmitPlanTool } from "./prompts.js";
import { MAX_PLAN_STEPS, validatePlan } from "./schema.js";
import { planAvailableTools, type Plan, type PlanErrorCode, type PlanStep, type PlanToolName } from "./types.js";

/** Re-plan 次数上限。 */
export const MAX_REPLAN = 1;
/** 一次 Re-plan 预留的模型调用数（与 Planner 同为一次结构化输出）。 */
export const REPLAN_MODEL_COST = 1;

export type ReplanReason = "tool_temporary_failure" | "unexecutable_action";

/** 错误码到重规划原因的映射；不在这里的错误码默认不允许重规划。 */
const REASON_BY_CODE: Partial<Record<PlanErrorCode, ReplanReason>> = {
  tool_failed: "tool_temporary_failure",
  step_tool_limit: "unexecutable_action",
  step_turn_limit: "unexecutable_action",
  tool_not_allowed: "unexecutable_action",
};

export interface ReplanGateInput {
  errorCode: PlanErrorCode;
  /** 已发生的 Re-plan 次数。 */
  replanCount: number;
  /** 当前还剩多少模型调用预算（已扣除本次步骤）。 */
  remainingModelCalls: number;
  aborted?: boolean;
}

export type ReplanDecision =
  | { allowed: true; reason: ReplanReason }
  | { allowed: false; code: PlanErrorCode; message: string };

/**
 * 是否允许进入 Re-plan。顺序即优先级：
 * 中止与用户拒绝不可绕过，其次才是次数与预算。
 */
export function decideReplan(input: ReplanGateInput): ReplanDecision {
  if (input.aborted) {
    return { allowed: false, code: "aborted", message: "请求已中止，不再重规划" };
  }
  if (input.errorCode === "confirm_denied") {
    return {
      allowed: false,
      code: "confirm_denied",
      message: "用户已拒绝该动作，不允许换一种方式继续",
    };
  }
  if (
    input.errorCode === "invalid_plan" ||
    input.errorCode === "plan_empty" ||
    input.errorCode === "plan_too_long"
  ) {
    return {
      allowed: false,
      code: "invalid_plan",
      message: "计划本身非法且无法通过重规划修正",
    };
  }
  if (input.replanCount >= MAX_REPLAN) {
    return { allowed: false, code: "replan_limit", message: "已达到 Re-plan 次数上限" };
  }
  if (input.remainingModelCalls < REPLAN_MODEL_COST) {
    return {
      allowed: false,
      code: "model_budget_exhausted",
      message: "模型调用预算不足，无法重规划",
    };
  }

  const reason = REASON_BY_CODE[input.errorCode];
  if (!reason) {
    return {
      allowed: false,
      code: input.errorCode,
      message: `错误 ${input.errorCode} 不属于可恢复的计划问题`,
    };
  }
  return { allowed: true, reason };
}

export interface ReplanContextInput {
  planId: string;
  goal: string;
  previousPlan: Plan;
  /** 旧计划的版本号；新计划为 revision + 1。 */
  revision: number;
  completedSteps: Array<{ step: PlanStep; summary: string }>;
  failedStep: PlanStep;
  errorCode: PlanErrorCode;
  reason: ReplanReason;
  /** 新计划允许的总步数（已完成 + 剩余预算能支撑的新步骤）。 */
  maxSteps: number;
  remainingModelCalls: number;
  /** 不可绕过的动作，例如用户拒绝过的 draft_message 描述。 */
  blockedActions: string[];
  /** 本次请求是否开启知识库检索；决定 searchDocs 能不能继续用。 */
  searchDocs: boolean;
  model: string;
}

export type ReplanResult =
  | { kind: "replanned"; revision: number; plan: Plan; reason: ReplanReason; note: string }
  | { kind: "rejected"; code: PlanErrorCode; message: string };

export interface Replanner {
  replan(context: ReplanContextInput): Promise<ReplanResult>;
}

export interface ReplanCandidateOptions {
  previousPlan: Plan;
  completedCount: number;
  maxSteps: number;
  /** 本次可用的工具名；不传则只按白名单校验形状。 */
  availableTools?: PlanToolName[];
}

export type ReplanCandidateValidation =
  | { ok: true; plan: Plan }
  | { ok: false; code: PlanErrorCode; message: string };

function sameStep(left: PlanStep, right: PlanStep): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.action === right.action &&
    left.doneWhen === right.doneWhen &&
    left.tools.length === right.tools.length &&
    left.tools.every((tool, index) => tool === right.tools[index])
  );
}

/**
 * 校验 Re-plan 产物：形状合法、已完成步骤未被改写、步数不超预算。
 * 与 validatePlan 分开，因为这里多了「历史不可改写」这一层。
 */
export function validateReplanCandidate(
  raw: unknown,
  options: ReplanCandidateOptions,
): ReplanCandidateValidation {
  const base = validatePlan(raw, { availableTools: options.availableTools });
  if (!base.ok) return base;

  const plan = base.plan;
  if (plan.goal !== options.previousPlan.goal) {
    return { ok: false, code: "invalid_plan", message: "Re-plan 不能修改总目标" };
  }

  for (let index = 0; index < options.completedCount; index += 1) {
    const before = options.previousPlan.steps[index];
    const after = plan.steps[index];
    if (!before || !after || !sameStep(before, after)) {
      return {
        ok: false,
        code: "invalid_plan",
        message: `Re-plan 不能修改已完成步骤 ${before?.id ?? index + 1}`,
      };
    }
  }

  if (plan.steps.length > Math.min(options.maxSteps, MAX_PLAN_STEPS)) {
    return {
      ok: false,
      code: "model_budget_exhausted",
      message: `Re-plan 步骤数超过剩余预算允许的 ${Math.min(options.maxSteps, MAX_PLAN_STEPS)} 步`,
    };
  }

  if (plan.steps.length <= options.completedCount) {
    return { ok: false, code: "invalid_plan", message: "Re-plan 没有产生可继续执行的步骤" };
  }

  return { ok: true, plan };
}

/** Re-plan 的 system prompt：把「不许改什么」写在最前面，减少无效产出。 */
export function buildReplanSystemPrompt(input: ReplanContextInput): string {
  const completed = input.completedSteps.length
    ? input.completedSteps
        .map(
          (item) =>
            [
              `- ${item.step.id}`,
              `  标题：${item.step.title}`,
              `  动作：${item.step.action}`,
              `  完成条件：${item.step.doneWhen}`,
              `  工具：${item.step.tools.length ? item.step.tools.join("、") : "（无）"}`,
              `  执行结果：${item.summary}`,
            ].join("\n"),
        )
        .join("\n")
    : "（无）";
  const blocked = input.blockedActions.length
    ? input.blockedActions.map((action) => `- ${action}`).join("\n")
    : "（无）";
  const availableTools = planAvailableTools(input.searchDocs);

  return [
    "你是 Plan-and-Execute 的 Re-plan 模块，只修正计划，不直接回答用户。",
    "",
    "硬约束：",
    `1. 前 ${input.completedSteps.length} 个已完成步骤必须原样保留：下面清单已给出 id、标题、动作、完成条件、工具原文，` +
      "照抄即可，一个字都不要改，也不要重复执行。",
    `2. 新计划总步数不能超过 ${input.maxSteps} 步，且不能超过 6 步。`,
    "3. 只修正失败步骤及其后的步骤；不要扩大工具白名单。",
    `4. 只能使用这些工具：${availableTools.join("、")}；其他工具一律不要写进新计划。`,
    "5. 用户拒绝或安全拦截的动作不能换一种方式继续，下列动作禁止出现在新计划里：",
    blocked,
    "6. 无法在预算内修好时，给出更少、更保守的步骤，不要输出解释性文字。",
    "",
    "背景：",
    `- 总目标：${input.goal}`,
    `- 旧计划版本：revision ${input.revision}`,
    `- 失败步骤：${input.failedStep.id}｜${input.failedStep.title}`,
    `- 失败原因：${input.errorCode}（${input.reason}）`,
    `- 剩余模型调用：${input.remainingModelCalls}`,
    "",
    "已完成步骤：",
    completed,
    "",
    "请通过 emit_plan 输出修订后的完整计划。",
  ].join("\n");
}

export interface RealReplannerOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

/** 与 Planner 相同：只接受 emit_plan，失败就返回 rejected，由图上报告终态。 */
const EMIT_PLAN = "emit_plan";

export function createRealReplanner(options: RealReplannerOptions): Replanner {
  return {
    async replan(context: ReplanContextInput): Promise<ReplanResult> {
      const availableTools = planAvailableTools(context.searchDocs);
      const emitPlanTool = createEmitPlanTool(availableTools);
      const system = buildReplanSystemPrompt(context);
      const messages: TextMessage[] = [
        { role: "system", content: system },
        { role: "user", content: context.goal },
      ];

      return runPlanPlannerWithTracing(
        { planId: context.planId, revision: context.revision, model: context.model },
        async () => {
          const startedAt = Date.now();
          let parseError: string | null = null;
          let validationCode: string | null = null;
          try {
            const { choice } = await requestCompletion(
              messages,
              {
                messages,
                model: context.model,
                baseUrl: options.baseUrl,
                signal: options.signal,
                onDelta: () => {},
                onUsage: options.onUsage,
              },
              options.apiKey,
              { disableThinking: true, tools: [emitPlanTool] },
            );
            const call = choice.message?.tool_calls?.find(
              (item) => item.function.name === EMIT_PLAN,
            );
            if (!call) {
              validationCode = "planner_failed";
              return {
                result: {
                  kind: "rejected",
                  code: "planner_failed",
                  message: "Re-plan 模型没有调用 emit_plan",
                } as const,
                hasToolCall: false,
                stepCount: null,
                validationCode,
                fellBack: true,
                latencyMs: Date.now() - startedAt,
                modelCalls: 1,
              };
            }

            let raw: unknown;
            try {
              raw = JSON.parse(call.function.arguments);
            } catch {
              parseError = "Re-plan 的 emit_plan 参数不是合法 JSON";
              validationCode = "invalid_plan";
              return {
                result: {
                  kind: "rejected",
                  code: "invalid_plan",
                  message: parseError,
                } as const,
                hasToolCall: true,
                stepCount: null,
                validationCode,
                fellBack: true,
                latencyMs: Date.now() - startedAt,
                modelCalls: 1,
              };
            }

            const checked = validateReplanCandidate(raw, {
              previousPlan: context.previousPlan,
              completedCount: context.completedSteps.length,
              maxSteps: context.maxSteps,
              availableTools,
            });
            if (!checked.ok) {
              validationCode = checked.code;
              return {
                result: {
                  kind: "rejected",
                  code: checked.code,
                  message: checked.message,
                } as const,
                hasToolCall: true,
                stepCount: null,
                validationCode,
                fellBack: true,
                latencyMs: Date.now() - startedAt,
                modelCalls: 1,
              };
            }

            return {
              result: {
                kind: "replanned",
                revision: context.revision + 1,
                plan: checked.plan,
                reason: context.reason,
                note: `步骤 ${context.failedStep.id} 失败（${context.errorCode}），已重新规划`,
              } as const,
              hasToolCall: true,
              stepCount: checked.plan.steps.length,
              validationCode: null,
              fellBack: false,
              latencyMs: Date.now() - startedAt,
              modelCalls: 1,
            };
          } catch (error) {
            return {
              result: {
                kind: "rejected",
                code: "planner_failed",
                message: error instanceof Error ? error.message : "Re-plan 模型调用失败",
              } as const,
              hasToolCall: false,
              stepCount: null,
              validationCode: "planner_failed",
              fellBack: true,
              latencyMs: Date.now() - startedAt,
              modelCalls: 1,
            };
          }
        },
      ).then((outcome) => outcome.result);
    },
  };
}
