/**
 * Mock Planner / Mock StepExecutor / Mock ConfirmSession。
 *
 * 目的：不依赖 API Key 就能跑通整张图和 SSE 事件顺序。
 * 真实实现（步骤 4 / 5）接入后，这些 mock 只留在测试里。
 */
import type { ConfirmAction } from "../react/confirmGate.js";
import type { Planner, PlanContext, PlannerResult } from "./planner.js";
import type { StepExecutor, StepContext } from "./executor.js";
import type { Plan, PlanErrorCode, PlanStep, PlanStepResult, PlanToolName } from "./types.js";

export function mockStep(index: number, tools: PlanToolName[] = []): PlanStep {
  return {
    id: `step_${index}`,
    title: `步骤 ${index}`,
    action: "执行一个明确动作",
    doneWhen: "得到可检查的结果",
    tools,
  };
}

export function mockPlan(steps: PlanStep[], goal = "完成多步任务"): Plan {
  return { goal, steps };
}

export function planScenario(plan: Plan): (ctx: PlanContext) => PlannerResult {
  return () => ({ kind: "plan", plan });
}

export function fallbackScenario(
  reasonCode: PlanErrorCode,
  message: string,
): (ctx: PlanContext) => PlannerResult {
  return () => ({ kind: "fallback", reasonCode, message });
}

/** 按预置剧本出计划；没有命中就回退 ReAct。 */
export class MockPlanner implements Planner {
  constructor(
    private readonly scenarios: Array<(ctx: PlanContext) => PlannerResult | null> = [],
  ) {}

  async plan(context: PlanContext): Promise<PlannerResult> {
    for (const scenario of this.scenarios) {
      const result = scenario(context);
      if (result) return result;
    }
    return {
      kind: "fallback",
      reasonCode: "planner_failed",
      message: "MockPlanner 没有命中剧本，回退 ReAct",
    };
  }
}

export interface MockExecutorOptions {
  /** 1 起的步骤号；命中时返回失败（只失败一次，重试则成功，用于验证 Re-plan）。 */
  failSteps?: number[];
  failCode?: PlanErrorCode;
  /** 1 起的步骤号；命中时先走确认闸门。 */
  confirmSteps?: number[];
}

const MOCK_TOOL_RESULTS: Record<PlanToolName, unknown> = {
  getWeather: { location: "广州", temperature: "28℃", condition: "多云" },
  getCurrentTime: { iso: "2026-11-04T10:00:00+08:00" },
  searchDocs: { hits: [{ title: "检索片段", score: 0.9 }] },
  draft_message: { drafted: true },
};

export class MockStepExecutor implements StepExecutor {
  /** 记录已失败过的步骤号，保证重规划后同一步骤重试时成功。 */
  private readonly failedOnce = new Set<number>();

  constructor(private readonly options: MockExecutorOptions = {}) {}

  async runStep(context: StepContext): Promise<PlanStepResult> {
    const startedAt = Date.now();
    const { step, index, planId, revision, signal, confirmSession, onTrace } = context;
    const stepNumber = index + 1;
    const toolsCalled: string[] = [];

    const aborted = (): PlanStepResult => ({
      stepId: step.id,
      status: "aborted",
      summary: "用户中止",
      toolsCalled,
      errorCode: "aborted",
      startedAt,
      finishedAt: Date.now(),
    });

    if (signal?.aborted) return aborted();

    if (this.options.failSteps?.includes(stepNumber) && !this.failedOnce.has(stepNumber)) {
      this.failedOnce.add(stepNumber);
      return {
        stepId: step.id,
        status: "failed",
        summary: `步骤 ${stepNumber} 模拟失败`,
        toolsCalled,
        errorCode: this.options.failCode ?? "tool_failed",
        startedAt,
        finishedAt: Date.now(),
      };
    }

    if (this.options.confirmSteps?.includes(stepNumber)) {
      if (!confirmSession) {
        return {
          stepId: step.id,
          status: "failed",
          summary: "需要确认但没有确认通道",
          toolsCalled,
          errorCode: "tool_not_allowed",
          startedAt,
          finishedAt: Date.now(),
        };
      }
      const callId = `${planId}:${revision}:${step.id}`;
      onTrace?.({
        type: "pending_confirm",
        confirmId: confirmSession.confirmId,
        toolCallId: callId,
        name: "draft_message",
        arguments: { action: step.action },
      });
      const action: ConfirmAction = await confirmSession.wait(callId, "draft_message", { action: step.action }, signal);
      onTrace?.({ type: "confirm_resolved", toolCallId: callId, name: "draft_message", action });
      if (action === "deny") {
        return {
          stepId: step.id,
          status: "failed",
          summary: "用户拒绝执行该操作",
          toolsCalled,
          errorCode: "confirm_denied",
          startedAt,
          finishedAt: Date.now(),
        };
      }
    }

    for (const name of step.tools) {
      if (signal?.aborted) return aborted();
      onTrace?.({ type: "tool_call", name, arguments: { action: step.action } });
      const result = MOCK_TOOL_RESULTS[name as PlanToolName] ?? { error: "未知工具" };
      onTrace?.({ type: "tool_result", name, result });
      toolsCalled.push(name);
    }

    if (signal?.aborted) return aborted();

    return {
      stepId: step.id,
      status: "done",
      summary: `步骤 ${stepNumber} 完成：${step.title}`,
      toolsCalled,
      startedAt,
      finishedAt: Date.now(),
    };
  }
}

/** 测试用的 ConfirmSession 桩：wait 直接返回预设动作，不碰 Map 和路由。 */
export class MockConfirmSession {
  readonly confirmId = "mock_confirm";

  constructor(private readonly action: ConfirmAction) {}

  async wait(): Promise<ConfirmAction> {
    return this.action;
  }

  resolve(): boolean { return false; }
  listPending() { return []; }
  dispose(): void {}
}
