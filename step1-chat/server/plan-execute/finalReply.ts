/**
 * 最终回答节点：把「已完成的步骤」组织成给用户的一段答复。
 *
 * 为什么单独成模块：图只负责编排，模型调用集中在这里，
 * 测试时换成假实现就能断言「最终回答只引用已执行步骤」这类约束。
 */
import { requestCompletion } from "../react/complete.js";
import type { TextMessage } from "../react/types.js";
import { buildFinalReplySystemPrompt } from "./prompts.js";
import type { Plan, PlanStepResult } from "./types.js";

export interface FinalReplyContext {
  goal: string;
  plan: Plan;
  stepResults: PlanStepResult[];
  model: string;
}

export type FinalReplyResult =
  | { kind: "text"; text: string }
  | { kind: "failed"; message: string };

export interface FinalReplier {
  reply(context: FinalReplyContext): Promise<FinalReplyResult>;
}

export interface RealFinalReplierOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

export function createRealFinalReplier(options: RealFinalReplierOptions): FinalReplier {
  return {
    async reply(context: FinalReplyContext): Promise<FinalReplyResult> {
      const doneResults = context.stepResults.filter((result) => result.status === "done");
      const failedResults = context.stepResults.filter(
        (result) => result.status !== "done" && result.status !== "pending",
      );

      // 计划里还没轮到的步骤也要如实标注为未执行。
      const executedIds = new Set(context.stepResults.map((result) => result.stepId));
      const unexecuted = context.plan.steps.filter((step) => !executedIds.has(step.id));

      const system = buildFinalReplySystemPrompt({
        goal: context.goal,
        completedSteps: doneResults.map((result) => ({
          title: stepTitle(context.plan, result.stepId),
          summary: result.summary,
        })),
        failedSteps: [
          ...failedResults.map((result) => ({
            title: stepTitle(context.plan, result.stepId),
            summary: result.summary,
          })),
          ...unexecuted.map((step) => ({ title: step.title, summary: "未执行" })),
        ],
        totalSteps: context.plan.steps.length,
      });

      const messages: TextMessage[] = [
        { role: "system", content: system },
        { role: "user", content: context.goal },
      ];

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
          // 最终回答不再调用工具：工具轮已经在 Executor 里结束。
          { disableThinking: true, tools: [] },
        );
        const text = (choice.message?.content ?? "").trim();
        if (!text) return { kind: "failed", message: "最终回答为空" };
        return { kind: "text", text };
      } catch (error) {
        return {
          kind: "failed",
          message: error instanceof Error ? error.message : "最终回答模型调用失败",
        };
      }
    },
  };
}

function stepTitle(plan: Plan, stepId: string): string {
  return plan.steps.find((step) => step.id === stepId)?.title ?? stepId;
}
