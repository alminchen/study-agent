/**
 * Executor 契约 + 真实实现：执行计划里的单个步骤。
 *
 * 三条硬约束（步骤 5 验收）：
 * - 每步最多 2 次模型调用；第二轮还要工具 → step_turn_limit
 * - 每步的工具调用数不超过 3（由 PlanSchema 保证，这里再兜一层）
 * - 确认拒绝原样返回 confirm_denied，不被 Executor 吞掉或改写
 */
import { applyToolCalls } from "../react/applyToolCalls.js";
import { requestCompletion } from "../react/complete.js";
import { isToolErrorResult } from "../react/toolFailure.js";
import type { ConfirmSession } from "../react/confirmGate.js";
import type { ProviderMessage, ToolTraceHandler } from "../react/types.js";
import type { ConsecutiveFailureTracker } from "../react/toolFailure.js";
import type { ContextMemoryBlock } from "../context/types.js";
import { findTool } from "../tools/index.js";
import type { ToolSchema } from "../tools/types.js";
import { buildStepSystemPrompt } from "./prompts.js";
import type { Plan, PlanErrorCode, PlanStep, PlanStepResult } from "./types.js";

/**
 * Executor 契约：执行计划里的单个步骤，返回不可信的 PlanStepResult。
 * 图不信任模型自报，只读返回值决定下一步。
 */
export interface StepContext {
  plan: Plan;
  step: PlanStep;
  index: number;
  planId: string;
  revision: number;
  model: string;
  apiKey: string;
  confirmSession?: ConfirmSession;
  failures: ConsecutiveFailureTracker;
  onTrace?: ToolTraceHandler;
  signal?: AbortSignal;
  /** 已完成步骤的摘要；当前步骤据此避免重复劳动。 */
  completedSummaries?: string[];
  /** 预检索好的长期记忆块；只影响本步骤的产出内容。 */
  memoryBlock?: ContextMemoryBlock | null;
}

export interface StepExecutor {
  runStep(context: StepContext): Promise<PlanStepResult>;
}

/** 计划非法或 MockPlanner 未命中时的 ReAct 兜底入口；步骤 6 接真实实现。 */
export interface ReactFallbackRunner {
  run(): Promise<void>;
}

/** 单步最多问模型几次：第一轮取工具，第二轮出摘要。 */
export const MAX_STEP_MODEL_TURNS = 2;

export interface RealExecutorOptions {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

/**
 * 把步骤声明的工具名映射成本地 schema；查不到的工具直接略过。
 * 同一个工具只保留一份 schema：重复项会让模型看到两个同名函数并重复调用。
 */
function schemasForTools(names: string[]): ToolSchema[] {
  const schemas: ToolSchema[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tool = findTool(name);
    if (tool) schemas.push(tool.schema);
  }
  return schemas;
}

export function createRealExecutor(options: RealExecutorOptions): StepExecutor {
  return {
    async runStep(context: StepContext): Promise<PlanStepResult> {
      const startedAt = Date.now();
      const { step, signal, confirmSession, failures } = context;
      const toolsCalled: string[] = [];

      const finish = (
        status: PlanStepResult["status"],
        summary: string,
        errorCode?: PlanErrorCode,
      ): PlanStepResult => ({
        stepId: step.id,
        status,
        summary,
        toolsCalled,
        errorCode,
        startedAt,
        finishedAt: Date.now(),
      });

      if (signal?.aborted) {
        return finish("aborted", "用户中止", "aborted");
      }

      // 用 string[] 承载白名单：模型返回的工具名是任意字符串，要能比较。
      const allowedToolNames: string[] = [...new Set(step.tools)];
      const allowedSchemas = schemasForTools(allowedToolNames);
      const system = buildStepSystemPrompt({
        goal: context.plan.goal,
        title: step.title,
        action: step.action,
        doneWhen: step.doneWhen,
        completedSummaries: context.completedSummaries ?? [],
        allowedToolNames,
        memoryBlock: context.memoryBlock,
      });

      const messages: ProviderMessage[] = [
        { role: "system", content: system },
        { role: "user", content: step.action },
      ];

      const callModel = async () => {
        const { choice } = await requestCompletion(
          // 必须传完整 messages：第二轮要带上第一轮的工具结果回填。
          messages,
          {
            // requestCompletion 只用第一个入参；这里是 ReactLoopOptions 的必填字段。
            messages: [{ role: "system", content: system }, { role: "user", content: step.action }],
            model: context.model,
            baseUrl: options.baseUrl,
            signal: options.signal ?? signal,
            onDelta: () => {},
            onUsage: options.onUsage,
          },
          context.apiKey,
          // 空数组也要显式传：本步骤没有工具时不能退回聊天工具列表。
          { disableThinking: true, tools: allowedSchemas },
        );
        return choice;
      };

      let turn = 0;
      let lastText = "";

      while (turn < MAX_STEP_MODEL_TURNS) {
        if (signal?.aborted) return finish("aborted", "用户中止", "aborted");
        turn += 1;

        let choice;
        try {
          choice = await callModel();
        } catch (error) {
          return finish(
            "failed",
            error instanceof Error ? error.message : "模型调用失败",
            "tool_failed",
          );
        }

        const toolCalls = choice.message?.tool_calls ?? [];

        // 没有工具调用 → 模型已经给出本步骤的结论。
        if (toolCalls.length === 0) {
          lastText = (choice.message?.content ?? "").trim();
          return finish("done", lastText || `步骤 ${step.title} 已完成`);
        }

        // 工具名必须落在当前步骤白名单内；越界直接判失败，不执行任何工具。
        const disallowed = toolCalls.find((call) => !allowedToolNames.includes(call.function.name));
        if (disallowed) {
          return finish(
            "failed",
            `模型调用了本步骤不允许的工具：${disallowed.function.name}`,
            "tool_not_allowed",
          );
        }

        // 工具数上限由 PlanSchema 保证，这里再兜一层，防止模型多轮叠加。
        if (toolsCalled.length + toolCalls.length > 3) {
          return finish("failed", "本步骤工具调用数量超过上限", "step_tool_limit");
        }

        // 记录 assistant 的 tool_calls，之后要把 tool 结果成对回填。
        messages.push({
          role: "assistant",
          content: choice.message?.content ?? null,
          tool_calls: toolCalls,
          // DeepSeek 思考模式：下一轮必须原样带回。
          reasoning_content: choice.message?.reasoning_content ?? null,
        });

        const before = messages.length;
        await applyToolCalls(
          toolCalls,
          messages,
          context.onTrace,
          turn,
          failures,
          confirmSession,
          signal,
        );
        for (const call of toolCalls) toolsCalled.push(call.function.name);

        if (signal?.aborted) return finish("aborted", "用户中止", "aborted");

        // 工具结果是错误（用户拒绝 / 工具失败）→ 本步骤失败，不再问模型。
        const toolResults = messages.slice(before);
        const denied = toolResults.some((row) => {
          if (row.role !== "tool") return false;
          try {
            const parsed = JSON.parse(row.content) as { error?: unknown };
            return typeof parsed.error === "string" && parsed.error.includes("用户拒绝");
          } catch {
            return false;
          }
        });
        if (denied) {
          return finish("failed", "用户拒绝执行该操作", "confirm_denied");
        }
        const failed = toolResults.some(
          (row) => row.role === "tool" && isToolErrorResult(safeParse(row.content)),
        );
        if (failed) {
          // 把工具自己的错误带出来：只写「工具执行失败」没法定位是知识库没初始化还是参数不对。
          return finish("failed", `工具执行失败：${firstToolError(toolResults)}`, "tool_failed");
        }

        // 第二轮：工具结果已回填，让模型输出本步骤摘要。
        if (turn >= MAX_STEP_MODEL_TURNS) {
          return finish("failed", "本步骤已达到模型调用次数上限", "step_turn_limit");
        }
      }

      return finish("failed", "本步骤未产生结果", "step_turn_limit");
    },
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 取第一条工具错误文本（截断），用于失败摘要；没有就返回通用文案。 */
function firstToolError(toolResults: ProviderMessage[]): string {
  for (const row of toolResults) {
    if (row.role !== "tool") continue;
    const parsed = safeParse(row.content) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim().slice(0, 120);
    }
  }
  return "未知原因";
}
