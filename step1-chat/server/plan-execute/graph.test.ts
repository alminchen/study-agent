import assert from "node:assert/strict";
import test from "node:test";
import type { ReactFallbackRunner, StepExecutor, StepContext } from "./executor.js";
import type { FinalReplier } from "./finalReply.js";
import { runPlanGraph, type PlanGraphState } from "./graph.js";
import type { Planner, PlanContext, PlannerResult } from "./planner.js";
import { mockPlan, mockStep } from "./mock.js";
import type { Plan, PlanEvent, PlanStepResult } from "./types.js";

const COMPLEX_INPUT = "先查资料，再写一份部署方案对比";
const SIMPLE_INPUT = "你好";

function collector() {
  const events: PlanEvent[] = [];
  return { events, onEvent: (event: PlanEvent) => events.push(event) };
}

/** 记录调用次数，方便断言「简单任务不调用 Planner」。 */
function fakePlanner(result: PlannerResult | ((ctx: PlanContext) => PlannerResult)) {
  let calls = 0;
  const planner: Planner = {
    async plan(context) {
      calls += 1;
      return typeof result === "function" ? result(context) : result;
    },
  };
  return {
    planner,
    get calls() {
      return calls;
    },
  };
}

function fakeExecutor(handler: (context: StepContext) => PlanStepResult | Promise<PlanStepResult>) {
  let calls = 0;
  const executor: StepExecutor = {
    async runStep(context) {
      calls += 1;
      return handler(context);
    },
  };
  return {
    executor,
    get calls() {
      return calls;
    },
  };
}

function doneResult(context: StepContext): PlanStepResult {
  return {
    stepId: context.step.id,
    status: "done",
    summary: `${context.step.title}完成`,
    toolsCalled: [],
    startedAt: 0,
    finishedAt: 1,
  };
}

function failingExecutor(code: PlanStepResult["errorCode"]) {
  return fakeExecutor((context) => ({
    stepId: context.step.id,
    status: "failed",
    summary: "这一步失败了",
    toolsCalled: [],
    errorCode: code,
    startedAt: 0,
    finishedAt: 1,
  }));
}

function fakeReplier(text = "最终回答") {
  let calls = 0;
  const replier: FinalReplier = {
    async reply() {
      calls += 1;
      return { kind: "text", text };
    },
  };
  return {
    replier,
    get calls() {
      return calls;
    },
  };
}

function fakeFallback() {
  let calls = 0;
  const runner: ReactFallbackRunner = {
    async run() {
      calls += 1;
    },
  };
  return {
    runner,
    get calls() {
      return calls;
    },
  };
}

const TWO_STEP_PLAN: Plan = mockPlan([mockStep(1), mockStep(2)], "先查资料，再写一份部署方案对比");

interface RunOptions {
  userMessage?: string;
  plan?: Plan | null;
  executor?: ReturnType<typeof fakeExecutor>;
  replierText?: string;
  maxModelCalls?: number;
  signal?: AbortSignal;
}

async function run(options: RunOptions = {}) {
  const events = collector();
  const planner = fakePlanner(
    options.plan === null
      ? { kind: "fallback", reasonCode: "invalid_plan", message: "计划非法" }
      : { kind: "plan", plan: options.plan ?? TWO_STEP_PLAN },
  );
  const executor = options.executor ?? fakeExecutor(doneResult);
  const replier = fakeReplier(options.replierText ?? "最终回答");
  const fallback = fakeFallback();
  const deltas: string[] = [];

  const state = await runPlanGraph({
    messages: [{ role: "user", content: options.userMessage ?? COMPLEX_INPUT }],
    model: "deepseek-chat",
    apiKey: "test-key",
    planner: planner.planner,
    executor: executor.executor,
    finalReplier: replier.replier,
    reactFallback: fallback.runner,
    onEvent: events.onEvent,
    onDelta: (delta) => deltas.push(delta),
    maxModelCalls: options.maxModelCalls,
    signal: options.signal,
  });

  return { state, events: events.events, deltas, planner, executor, replier, fallback };
}

test("简单任务：不调用 Planner，直接走 ReAct", async () => {
  const result = await run({ userMessage: SIMPLE_INPUT });
  assert.equal(result.planner.calls, 0);
  assert.equal(result.fallback.calls, 1);
  assert.equal(result.executor.calls, 0);
  assert.equal(result.state.terminalStatus, "completed");
  assert.ok(!result.events.some((event) => event.type === "plan_created"));
});

test("复杂任务：先推 plan_created，再进第一步", async () => {
  const result = await run();
  const types = result.events.map((event) => event.type);
  assert.equal(types[0], "plan_route");
  assert.equal(types[1], "plan_created");
  assert.equal(types[2], "plan_step_started");
  assert.equal(result.planner.calls, 1);
});

test("每一步都有 started 与 done", async () => {
  const result = await run();
  const started = result.events.filter((event) => event.type === "plan_step_started");
  const done = result.events.filter((event) => event.type === "plan_step_done");
  assert.equal(started.length, 2);
  assert.equal(done.length, 2);
  assert.equal(result.state.stepResults.length, 2);
  assert.equal(result.state.terminalStatus, "completed");
});

test("计划非法：只回退 ReAct 一次，不重试 Planner", async () => {
  const result = await run({ plan: null });
  assert.equal(result.planner.calls, 1);
  assert.equal(result.fallback.calls, 1);
  assert.equal(result.executor.calls, 0);
  const fallbacks = result.events.filter((event) => event.type === "plan_fallback");
  assert.equal(fallbacks.length, 1);
});

test("知识库未开启：计划里的 searchDocs 视为非法，回退 ReAct", async () => {
  // 计划引用了不可用工具 → 执行必然工具失败，不如在执行前拦下并明确回退。
  const events = collector();
  const planner = fakePlanner({
    kind: "plan",
    plan: mockPlan([mockStep(1, ["searchDocs"]), mockStep(2)], "先查资料，再写一份部署方案对比"),
  });
  const executor = fakeExecutor(doneResult);
  const fallback = fakeFallback();

  const state = await runPlanGraph({
    messages: [{ role: "user", content: COMPLEX_INPUT }],
    model: "deepseek-chat",
    apiKey: "test-key",
    searchDocs: false,
    planner: planner.planner,
    executor: executor.executor,
    finalReplier: fakeReplier().replier,
    reactFallback: fallback.runner,
    onEvent: events.onEvent,
    onDelta: () => {},
  });

  assert.equal(executor.calls, 0);
  assert.equal(fallback.calls, 1);
  assert.equal(state.terminalStatus, "completed");
  const fallbackEvent = events.events.find((event) => event.type === "plan_fallback");
  assert.ok(fallbackEvent && fallbackEvent.type === "plan_fallback");
  assert.equal(fallbackEvent.reasonCode, "invalid_plan");
});

test("步骤失败：推 step_failed 并终止，不再执行后续步骤", async () => {
  const failing = failingExecutor("tool_failed");
  const result = await run({ executor: failing });
  assert.equal(failing.calls, 1);
  assert.equal(result.state.terminalStatus, "failed");
  const failed = result.events.find((event) => event.type === "plan_step_failed");
  assert.equal(failed?.type, "plan_step_failed");
  assert.equal(filterCode(failed), "tool_failed");
});

test("模型预算耗尽：不再执行下一步", async () => {
  // Planner 1 次 + 第一步 2 次 = 3；第二步需要 2 次，超出预算。
  const result = await run({ maxModelCalls: 3 });
  assert.equal(result.executor.calls, 1);
  assert.equal(result.state.terminalStatus, "failed");
  const budgetError = result.events.find(
    (event) => event.type === "plan_step_failed" && event.code === "model_budget_exhausted",
  );
  assert.ok(budgetError, "应当上报 model_budget_exhausted");
});

test("中止后不再执行下一步", async () => {
  const controller = new AbortController();
  const events = collector();
  const planner = fakePlanner({ kind: "plan", plan: TWO_STEP_PLAN });
  const executor = fakeExecutor(doneResult);
  const replier = fakeReplier();
  const fallback = fakeFallback();

  const state = await runPlanGraph({
    messages: [{ role: "user", content: COMPLEX_INPUT }],
    model: "deepseek-chat",
    apiKey: "test-key",
    planner: planner.planner,
    executor: executor.executor,
    finalReplier: replier.replier,
    reactFallback: fallback.runner,
    onEvent: (event) => {
      events.onEvent(event);
      // 第一步刚完成，用户就点了停止。
      if (event.type === "plan_step_done" && event.stepId === "step_1") {
        controller.abort();
      }
    },
    onDelta: () => {},
    signal: controller.signal,
  });

  assert.equal(executor.calls, 1);
  assert.equal(replier.calls, 0);
  assert.equal(state.terminalStatus, "aborted");
});

test("最终回答只由已执行步骤生成，并写到 finalText / onDelta", async () => {
  const result = await run({ replierText: "部署方案对比：A 更快，B 更稳。" });
  assert.equal(result.replier.calls, 1);
  assert.match(result.state.finalText, /部署方案对比/);
  assert.deepEqual(result.deltas, ["部署方案对比：A 更快，B 更稳。"]);
  assert.equal(result.state.terminalStatus, "completed");
});

test("图状态包含文档要求的 10 个字段", async () => {
  const result = await run();
  const required: Array<keyof PlanGraphState> = [
    "messages",
    "mode",
    "classifyResult",
    "planRun",
    "currentStepIndex",
    "stepResults",
    "replanCount",
    "modelCalls",
    "finalText",
    "terminalStatus",
  ];
  for (const key of required) {
    assert.ok(key in result.state, `缺少图状态字段 ${key}`);
  }
  assert.equal(result.state.replanCount, 0);
  // Planner 1 + 两步各 2 + 最终回答 1
  assert.equal(result.state.modelCalls, 6);
});

function filterCode(event: PlanEvent | undefined): string | undefined {
  return event && event.type === "plan_step_failed" ? event.code : undefined;
}
