import assert from "node:assert/strict";
import test from "node:test";
import type { StepContext, StepExecutor } from "./executor.js";
import type { FinalReplier } from "./finalReply.js";
import { runPlanGraph, type RunPlanGraphOptions } from "./graph.js";
import { mockPlan, mockStep } from "./mock.js";
import type { Planner } from "./planner.js";
import {
  buildReplanSystemPrompt,
  decideReplan,
  validateReplanCandidate,
  type ReplanContextInput,
  type Replanner,
} from "./replan.js";
import type { Plan, PlanEvent, PlanStep, PlanStepResult } from "./types.js";

const basePlan: Plan = mockPlan([mockStep(1, ["searchDocs"]), mockStep(2, ["getWeather"])]);

function context(overrides: Partial<ReplanContextInput> = {}): ReplanContextInput {
  return {
    planId: "plan_test",
    goal: basePlan.goal,
    previousPlan: basePlan,
    revision: 0,
    completedSteps: [{ step: basePlan.steps[0]!, summary: "步骤 1 已完成" }],
    failedStep: basePlan.steps[1]!,
    errorCode: "tool_failed",
    reason: "tool_temporary_failure",
    maxSteps: 4,
    remainingModelCalls: 8,
    blockedActions: [],
    searchDocs: true,
    model: "test-model",
    ...overrides,
  };
}

test("工具临时失败允许重规划", () => {
  const decision = decideReplan({
    errorCode: "tool_failed",
    replanCount: 0,
    remainingModelCalls: 10,
  });
  assert.deepEqual(decision, { allowed: true, reason: "tool_temporary_failure" });
});

test("用户拒绝确认不进入重规划", () => {
  const decision = decideReplan({
    errorCode: "confirm_denied",
    replanCount: 0,
    remainingModelCalls: 10,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "confirm_denied");
});

test("请求中止不进入重规划", () => {
  const decision = decideReplan({
    errorCode: "tool_failed",
    replanCount: 0,
    remainingModelCalls: 10,
    aborted: true,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "aborted");
});

test("超过 Re-plan 次数上限后不再重规划", () => {
  const decision = decideReplan({
    errorCode: "tool_failed",
    replanCount: 1,
    remainingModelCalls: 10,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "replan_limit");
});

test("模型预算不足时不重规划", () => {
  const decision = decideReplan({
    errorCode: "tool_failed",
    replanCount: 0,
    remainingModelCalls: 0,
  });
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.code, "model_budget_exhausted");
});

test("Re-plan 候选不能修改已完成步骤", () => {
  const rewritten: Plan = {
    goal: basePlan.goal,
    steps: [
      { ...basePlan.steps[0]!, title: "被改写的步骤" },
      { ...basePlan.steps[1]!, action: "换一种方式完成" },
    ],
  };
  const checked = validateReplanCandidate(rewritten, {
    previousPlan: basePlan,
    completedCount: 1,
    maxSteps: 4,
  });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.equal(checked.code, "invalid_plan");
});

test("Re-plan 候选步数不能超过剩余预算", () => {
  const tooMany: Plan = mockPlan([
    basePlan.steps[0]!,
    mockStep(2),
    mockStep(3),
    mockStep(4),
    mockStep(5),
  ]);
  const checked = validateReplanCandidate(tooMany, {
    previousPlan: basePlan,
    completedCount: 1,
    maxSteps: 3,
  });
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.equal(checked.code, "model_budget_exhausted");
});

test("合法候选保留已完成步骤并通过校验", () => {
  const candidate: Plan = {
    goal: basePlan.goal,
    steps: [basePlan.steps[0]!, { ...basePlan.steps[1]!, action: "改用时间工具完成" }],
  };
  const checked = validateReplanCandidate(candidate, {
    previousPlan: basePlan,
    completedCount: 1,
    maxSteps: 4,
  });
  assert.equal(checked.ok, true);
  if (checked.ok) assert.equal(checked.plan.steps[1]!.action, "改用时间工具完成");
});

test("Re-plan prompt 写明已完成步骤与禁止动作", () => {
  const prompt = buildReplanSystemPrompt(context({ blockedActions: ["向张三发送辞职消息"] }));
  assert.match(prompt, /已完成步骤必须原样保留/);
  assert.match(prompt, /向张三发送辞职消息/);
  assert.match(prompt, /tool_failed/);
});

test("Re-plan prompt 给出已完成步骤的原文，模型才能照抄", () => {
  // 只给标题和摘要时，模型无法「原样保留」动作与完成条件，
  // 产出的候选会被判定为改写了已完成步骤。
  const prompt = buildReplanSystemPrompt(context());
  assert.match(prompt, new RegExp(escapeRegExp(basePlan.steps[0]!.action)));
  assert.match(prompt, new RegExp(escapeRegExp(basePlan.steps[0]!.doneWhen)));
  assert.match(prompt, new RegExp(escapeRegExp(basePlan.steps[0]!.tools.join("、"))));
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------- 图级验收：最多一次、旧计划不被覆盖、拒绝后不绕过 ---------------- */

interface HarnessOptions {
  executor: (context: StepContext, call: number) => PlanStepResult;
  replanner?: Replanner;
}

function harness({ executor, replanner }: HarnessOptions) {
  const events: PlanEvent[] = [];
  let executorCalls = 0;
  let replanCalls = 0;
  let reactCalls = 0;

  const contextStep = (stepContext: StepContext): PlanStepResult => {
    executorCalls += 1;
    return executor(stepContext, executorCalls);
  };

  const stepExecutor: StepExecutor = {
    async runStep(stepContext) {
      return contextStep(stepContext);
    },
  };
  const planner: Planner = { async plan() { return { kind: "plan", plan: basePlan }; } };
  const finalReplier: FinalReplier = {
    async reply() { return { kind: "text", text: "最终回答" }; },
  };

  const wrappedReplanner: Replanner | undefined = replanner
    ? {
        async replan(input) {
          replanCalls += 1;
          return replanner.replan(input);
        },
      }
    : undefined;

  const options: RunPlanGraphOptions = {
    messages: [{ role: "user", content: "先查资料，再写一份部署方案对比" }],
    model: "test-model",
    apiKey: "test-key",
    // basePlan 的 step_1 用 searchDocs：不开知识库时这类计划会被判非法。
    searchDocs: true,
    planner,
    executor: stepExecutor,
    finalReplier,
    replanner: wrappedReplanner,
    reactFallback: { async run() { reactCalls += 1; } },
    onEvent: (event) => events.push(event),
    onDelta: () => {},
  };

  return {
    events,
    options,
    get executorCalls() { return executorCalls; },
    get replanCalls() { return replanCalls; },
    get reactCalls() { return reactCalls; },
  };
}

function done(step: PlanStep, summary = "完成"): PlanStepResult {
  return { stepId: step.id, status: "done", summary, toolsCalled: [], startedAt: 0 };
}

function failed(step: PlanStep, errorCode: PlanStepResult["errorCode"]): PlanStepResult {
  return {
    stepId: step.id,
    status: "failed",
    summary: "模拟失败",
    toolsCalled: [],
    errorCode,
    startedAt: 0,
  };
}

const replannedPlan: Plan = {
  goal: basePlan.goal,
  steps: [basePlan.steps[0]!, { ...basePlan.steps[1]!, action: "改用时间工具完成" }],
};

test("图：失败一次后重规划并从失败步骤继续，旧计划不被覆盖", async () => {
  const cases = harness({
    executor: (context, call) =>
      context.index === 1 && call === 2 ? failed(context.step, "tool_failed") : done(context.step),
    replanner: {
      async replan() {
        return {
          kind: "replanned",
          revision: 1,
          plan: replannedPlan,
          reason: "tool_temporary_failure",
          note: "步骤 step_2 失败，已重新规划",
        };
      },
    },
  });

  const state = await runPlanGraph(cases.options);

  assert.equal(state.terminalStatus, "completed");
  assert.equal(state.replanCount, 1);
  assert.equal(cases.replanCalls, 1);
  assert.equal(cases.reactCalls, 0);
  assert.equal(cases.executorCalls, 3);
  assert.equal(state.finalText, "最终回答");

  const created = cases.events.find((event) => event.type === "plan_created");
  const replannedEvent = cases.events.find((event) => event.type === "plan_replanned");
  assert.ok(created && created.type === "plan_created");
  assert.ok(replannedEvent && replannedEvent.type === "plan_replanned");
  assert.equal(created.plan.steps[1]!.action, basePlan.steps[1]!.action);
  assert.equal(replannedEvent.previousRevision, 0);
  assert.equal(replannedEvent.revision, 1);
  assert.equal(replannedEvent.plan.steps[1]!.action, "改用时间工具完成");
});

test("图：确认拒绝后不进入 Re-plan，也没有替代工具调用", async () => {
  const cases = harness({
    executor: (context) => failed(context.step, "confirm_denied"),
    replanner: {
      async replan() {
        return {
          kind: "replanned",
          revision: 1,
          plan: replannedPlan,
          reason: "tool_temporary_failure",
          note: "不应发生",
        };
      },
    },
  });

  const state = await runPlanGraph(cases.options);

  assert.equal(state.terminalStatus, "failed");
  assert.equal(cases.replanCalls, 0);
  assert.equal(cases.executorCalls, 1);
  assert.equal(cases.events.some((event) => event.type === "plan_replanned"), false);
  assert.equal(state.stepResults[0]?.errorCode, "confirm_denied");
});

test("图：重规划后再次失败不再重规划", async () => {
  const cases = harness({
    executor: (context) => failed(context.step, "tool_failed"),
    replanner: {
      async replan() {
        return {
          kind: "replanned",
          revision: 1,
          plan: replannedPlan,
          reason: "tool_temporary_failure",
          note: "步骤 step_2 失败，已重新规划",
        };
      },
    },
  });

  const state = await runPlanGraph(cases.options);

  assert.equal(state.terminalStatus, "failed");
  assert.equal(state.replanCount, 1);
  assert.equal(cases.replanCalls, 1);
  assert.equal(cases.executorCalls, 2);

  const failureEvents = cases.events.filter((event) => event.type === "plan_step_failed");
  const codes = failureEvents.map((event) => (event.type === "plan_step_failed" ? event.code : ""));
  assert.deepEqual(codes, ["tool_failed", "tool_failed"]);
  assert.equal(
    cases.events.filter((event) => event.type === "plan_replanned").length,
    1,
  );
});

test("图：Re-plan 候选不合法时，步骤保留根因、计划级失败单独上报", async () => {
  // 候选改写了已完成步骤 → 候选被拒。
  // 事件必须区分两类：步骤上的 tool_failed（根因）和计划级的 invalid_plan（收尾原因），
  // 否则前端只会显示后者，根因被覆盖。
  const rewrittenPlan: Plan = {
    goal: basePlan.goal,
    steps: [
      { ...basePlan.steps[0]!, action: "被改写的动作" },
      { ...basePlan.steps[1]!, action: "继续原步骤" },
    ],
  };
  const cases = harness({
    executor: (context, call) =>
      context.index === 1 && call === 2 ? failed(context.step, "tool_failed") : done(context.step),
    replanner: {
      async replan() {
        return {
          kind: "replanned",
          revision: 1,
          plan: rewrittenPlan,
          reason: "tool_temporary_failure",
          note: "步骤 step_2 失败，已重新规划",
        };
      },
    },
  });

  const state = await runPlanGraph(cases.options);
  assert.equal(state.terminalStatus, "failed");

  const failures = cases.events.filter(
    (event): event is Extract<PlanEvent, { type: "plan_step_failed" }> =>
      event.type === "plan_step_failed",
  );
  const stepFailure = failures.find((event) => event.stepId !== "");
  const planFailure = failures.find((event) => event.stepId === "");
  assert.equal(stepFailure?.code, "tool_failed", "步骤上必须保留原始失败原因");
  assert.equal(planFailure?.code, "invalid_plan");
  assert.match(planFailure?.message ?? "", /Re-plan 未被采纳/);
});
