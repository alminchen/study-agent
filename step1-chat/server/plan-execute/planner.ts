/**
 * Planner 契约 + 真实实现。
 *
 * 真实 Planner 只做一件事：让模型用 emit_plan 工具吐出可校验的 JSON。
 * 模型只返回自由文本 → planner_failed；JSON 不合法 → invalid_plan；
 * 校验不过 → 对应的 plan_error_code。三类都回退 ReAct，不重试第二次。
 */
import { requestCompletion } from "../react/complete.js";
import type { TextMessage } from "../react/types.js";
import { runPlanPlannerWithTracing } from "../tracing/langsmith.js";
import { validatePlan } from "./schema.js";
import { buildPlanSystemPrompt, createEmitPlanTool } from "./prompts.js";
import { planAvailableTools, type Plan, type PlanErrorCode } from "./types.js";

export interface PlanContext {
  userMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  searchDocs: boolean;
  revision: number;
  planId: string;
  /** 仅重规划时传入，让 Planner 避开同一个坑。 */
  previousError?: PlanErrorCode;
}

export type PlannerResult =
  | { kind: "plan"; plan: Plan }
  | { kind: "fallback"; reasonCode: PlanErrorCode; message: string };

export interface Planner {
  plan(context: PlanContext): Promise<PlannerResult>;
}

export interface RealPlannerOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  /** 每次 LLM 调用的 token 用量回调，接 UsageAccumulator。 */
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

/** 只接受 emit_plan 的 arguments；模型给别的函数名一律当作 planner_failed。 */
const EMIT_PLAN = "emit_plan";

export function createRealPlanner(options: RealPlannerOptions): Planner {
  return {
    async plan(context: PlanContext): Promise<PlannerResult> {
      const availableTools = planAvailableTools(context.searchDocs);
      const emitPlanTool = createEmitPlanTool(availableTools);
      const system = buildPlanSystemPrompt({
        goal: context.userMessage,
        searchDocs: context.searchDocs,
        availableTools,
        revision: context.revision,
        previousError: context.previousError,
      });

      const messages: TextMessage[] = [
        { role: "system", content: system },
        { role: "user", content: context.userMessage },
      ];

      return runPlanPlannerWithTracing(
        { planId: context.planId, revision: context.revision, model: context.model },
        async () => {
          const startedAt = Date.now();
          let call;
          let modelCalls = 0;
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
            modelCalls = 1;
            call = choice.message?.tool_calls?.find((item) => item.function.name === EMIT_PLAN);
          } catch (error) {
            return {
              result: {
                kind: "fallback",
                reasonCode: "planner_failed",
                message: error instanceof Error ? error.message : "规划模型调用失败",
              } as const,
              hasToolCall: false,
              stepCount: null,
              validationCode: "planner_failed",
              fellBack: true,
              latencyMs: Date.now() - startedAt,
              modelCalls,
            };
          }

          if (!call) {
            return {
              result: {
                kind: "fallback",
                reasonCode: "planner_failed",
                message: "规划模型没有调用 emit_plan",
              } as const,
              hasToolCall: false,
              stepCount: null,
              validationCode: "planner_failed",
              fellBack: true,
              latencyMs: Date.now() - startedAt,
              modelCalls,
            };
          }

          let raw: unknown;
          try {
            raw = JSON.parse(call.function.arguments);
          } catch {
            return {
              result: {
                kind: "fallback",
                reasonCode: "invalid_plan",
                message: "emit_plan 的 arguments 不是合法 JSON",
              } as const,
              hasToolCall: true,
              stepCount: null,
              validationCode: "invalid_plan",
              fellBack: true,
              latencyMs: Date.now() - startedAt,
              modelCalls,
            };
          }

          const validation = validatePlan(raw, {
            requireSearchDocs: context.searchDocs,
            availableTools,
          });
          if (!validation.ok) {
            return {
              result: {
                kind: "fallback",
                reasonCode: validation.code,
                message: validation.message,
              } as const,
              hasToolCall: true,
              stepCount: null,
              validationCode: validation.code,
              fellBack: true,
              latencyMs: Date.now() - startedAt,
              modelCalls,
            };
          }

          return {
            result: { kind: "plan", plan: validation.plan } as const,
            hasToolCall: true,
            stepCount: validation.plan.steps.length,
            validationCode: null,
            fellBack: false,
            latencyMs: Date.now() - startedAt,
            modelCalls,
          };
        },
      ).then((outcome) => outcome.result);
    },
  };
}
