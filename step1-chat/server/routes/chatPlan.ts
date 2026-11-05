/**
 * Plan-and-Execute 聊天入口：POST /api/chat/plan（SSE）。
 *
 * 与 /api/chat（单 Agent ReAct）并存，不改写原有链路：
 *   校验请求 → 分类 → 计划 → 单步执行 →（受控 Re-plan）→ 最终回答
 *
 * 事件顺序：
 *   plan_route → plan_created → plan_step_started/done|failed
 *   →（可选 plan_replanned）→ delta → usage → [DONE]
 * 工具过程事件（tool_call / pending_confirm 等）与单 Agent 同形状，直接透传。
 *
 * 人工确认复用 ConfirmSession + POST /api/chat/confirm：
 *   Executor 在 runStep 里 await wait，SSE 此时保持连接；本文件 finally dispose。
 */
import type { Express } from "express";
import { z } from "zod";
import { createChatStream } from "../chat.js";
import { createRealExecutor } from "../plan-execute/executor.js";
import { createRealFinalReplier, type FinalReplier } from "../plan-execute/finalReply.js";
import { runPlanGraph, type PlanGraphState } from "../plan-execute/graph.js";
import { MockPlanner, MockStepExecutor, mockPlan, mockStep } from "../plan-execute/mock.js";
import { createPlanObserver, planUserPreview } from "../plan-execute/observe.js";
import { createRealPlanner, type Planner } from "../plan-execute/planner.js";
import { createRealReplanner, type Replanner } from "../plan-execute/replan.js";
import type { PlanChatMessage, PlanEvent, PlanMode } from "../plan-execute/types.js";
import { ConfirmSession } from "../react/confirmGate.js";
import type { ToolTraceHandler } from "../react/types.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { runPlanRequestWithTracing } from "../tracing/langsmith.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
import type { TokenUsage } from "../usage/types.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

/** 请求体契约与计划文档 6.1 对齐；model 必填，便于 Mock 与真实模型都可复现。 */
export const PlanChatRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .min(1),
  model: z.string().min(1),
  mode: z.enum(["auto", "react", "plan"]).optional(),
  searchDocs: z.boolean().optional(),
});

export interface RunPlanExecuteOptions {
  messages: PlanChatMessage[];
  model: string;
  mode?: PlanMode;
  searchDocs?: boolean;
  apiKey: string;
  baseUrl?: string;
  /** 无 Key 或 MOCK_MODE=1 时走 Mock Planner/Executor，不产生真实模型请求。 */
  mockMode: boolean;
  signal: AbortSignal;
  confirmSession: ConfirmSession;
  onEvent: (event: PlanEvent) => void;
  /** 计划事件与工具事件共用一个出口；ReAct 回退时会出现更宽的事件类型。 */
  onTrace: ToolTraceHandler;
  onDelta: (delta: string) => void;
  onUsage: (usage: TokenUsage, model: string) => void;
  /** 本次请求的 planId；不传则由图生成。 */
  planId?: string;
}

/** Mock 模式下的最终回答：只复述真实完成过的步骤，不假装调用过模型。 */
const mockFinalReplier: FinalReplier = {
  async reply(context) {
    const done = context.stepResults.filter((result) => result.status === "done");
    const summary = done.map((result) => result.summary).join("；");
    return {
      kind: "text",
      text: done.length
        ? `（Mock）已完成 ${done.length}/${context.plan.steps.length} 步：${summary}`
        : "（Mock）没有已完成的步骤",
    };
  },
};

function mockPlanner(userMessage: string, searchDocs: boolean): Planner {
  const goal = userMessage.slice(0, 500) || "完成多步任务";
  return new MockPlanner([
    () => ({
      kind: "plan",
      plan: mockPlan(
        [mockStep(1, searchDocs ? ["searchDocs"] : []), mockStep(2)],
        goal,
      ),
    }),
  ]);
}

/**
 * 装配组件并跑图。路由只负责 HTTP；这里可被测试直接调用，
 * 不依赖 Express。
 */
export function runPlanExecute(options: RunPlanExecuteOptions): Promise<PlanGraphState> {
  const planner = options.mockMode
    ? mockPlanner(
        options.messages.filter((message) => message.role === "user").at(-1)?.content ?? "",
        options.searchDocs === true,
      )
    : createRealPlanner({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        signal: options.signal,
        onUsage: options.onUsage,
      });
  const executor = options.mockMode
    ? new MockStepExecutor()
    : createRealExecutor({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        signal: options.signal,
        onUsage: options.onUsage,
      });
  const finalReplier = options.mockMode
    ? mockFinalReplier
    : createRealFinalReplier({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        signal: options.signal,
        onUsage: options.onUsage,
      });
  const replanner: Replanner | undefined = options.mockMode
    ? undefined
    : createRealReplanner({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        signal: options.signal,
        onUsage: options.onUsage,
      });

  return runPlanGraph({
    messages: options.messages,
    model: options.model,
    apiKey: options.apiKey,
    planId: options.planId,
    mode: options.mode,
    searchDocs: options.searchDocs,
    signal: options.signal,
    confirmSession: options.confirmSession,
    planner,
    executor,
    finalReplier,
    replanner,
    reactFallback: {
      run: async () => {
        await createChatStream({
          messages: options.messages,
          model: options.model,
          signal: options.signal,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          forceMock: options.mockMode,
          searchDocs: options.searchDocs === true,
          confirmSession: options.confirmSession,
          onUsage: options.onUsage,
          onDelta: options.onDelta,
          onTrace: options.onTrace,
        });
      },
    },
    onEvent: options.onEvent,
    onTrace: options.onTrace,
    onDelta: options.onDelta,
  });
}

export function registerChatPlanRoutes(app: Express): void {
  app.post("/api/chat/plan", async (req, res) => {
    // 先校验再声明 SSE：非法请求必须是 400 JSON，不能建模型请求，也不能开流。
    const parsed = PlanChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const hasUser = Array.isArray(req.body?.messages)
        && req.body.messages.some((message: { role?: unknown }) => message?.role === "user");
      res.status(400).json({
        error: hasUser ? "Plan 聊天请求参数不合法" : "messages 必须包含至少一条 user 消息",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }

    const { messages, model, mode, searchDocs } = parsed.data;
    setSseHeaders(res);

    // 客户端断开 → 中止图内所有模型请求与确认等待。
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    // 确认会话在构造时登记，前端拿 pending_confirm.confirmId 走 /api/chat/confirm。
    const confirmSession = new ConfirmSession();
    const usage = new UsageAccumulator();

    const writeEvent = (payload: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      const config = getRuntimeConfig();
      const selectedModel = model || config.model;

      // requestId 串起「前端一次请求」与「服务端一条日志」；planId 串起计划本身。
      const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const planId = `plan_${Date.now().toString(36)}`;
      const observer = createPlanObserver({ requestId, planId });
      const userPreview = planUserPreview(messages);

      const observation = await runPlanRequestWithTracing(
        { requestId, planId, mode: mode ?? "auto", userPreview },
        async () => {
          const state = await runPlanExecute({
            messages,
            model: selectedModel,
            mode,
            searchDocs,
            apiKey: config.apiKey,
            baseUrl: config.baseUrl,
            mockMode: config.mockMode,
            signal: abortController.signal,
            confirmSession,
            planId,
            onUsage: bindUsageCallback(usage, "plan", selectedModel),
            onEvent: (event) => {
              observer.onEvent(event);
              writeEvent(event);
            },
            onTrace: (event) => {
              observer.onTrace(event);
              writeEvent(event);
            },
            onDelta: (delta) => writeEvent({ delta }),
          });
          return observer.observe(state);
        },
      );

      // 只记观测字段和用户消息短预览；不落完整 prompt 与工具结果。
      console.log(`[plan] ${JSON.stringify({ ...observation, user_preview: userPreview })}`);

      writeUsageToStream(res, usage, "chat/plan", selectedModel);
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      if (!res.writableEnded) {
        const message = error instanceof Error ? error.message : "未知错误";
        writeEvent({ error: message });
        res.end();
      }
    } finally {
      confirmSession.dispose();
    }
  });
}
