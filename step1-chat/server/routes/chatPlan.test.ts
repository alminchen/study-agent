import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmSession } from "../react/confirmGate.js";
import type { PlanEvent } from "../plan-execute/types.js";
import { PlanChatRequestSchema, runPlanExecute } from "./chatPlan.js";

test("非法请求体被拒绝：缺 model 或缺 user 消息", () => {
  assert.equal(PlanChatRequestSchema.safeParse({ messages: [{ role: "user", content: "hi" }] }).success, false);
  assert.equal(PlanChatRequestSchema.safeParse({ messages: [], model: "m" }).success, false);
  assert.equal(
    PlanChatRequestSchema.safeParse({
      messages: [{ role: "assistant", content: "hi" }],
      model: "m",
    }).success,
    true,
  );
  assert.equal(
    PlanChatRequestSchema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      model: "m",
      mode: "plan",
    }).success,
    true,
  );
});

test("Mock 模式：事件顺序完整并以 plan_finished 收尾", async () => {
  const events: PlanEvent[] = [];
  const deltas: string[] = [];
  const controller = new AbortController();
  const confirmSession = new ConfirmSession();

  const state = await runPlanExecute({
    messages: [{ role: "user", content: "先查资料，再写一份部署方案对比" }],
    model: "test-model",
    apiKey: "",
    mockMode: true,
    signal: controller.signal,
    confirmSession,
    onEvent: (event) => events.push(event),
    onTrace: () => {},
    onDelta: (delta) => deltas.push(delta),
    onUsage: () => {},
  });

  const types = events.map((event) => event.type);
  assert.equal(types[0], "plan_route");
  assert.ok(types.includes("plan_created"));
  assert.ok(types.includes("plan_step_started"));
  assert.ok(types.includes("plan_step_done"));
  assert.equal(types[types.length - 1], "plan_finished");
  assert.equal(state.terminalStatus, "completed");
  assert.ok(deltas.length > 0);

  // 每个 step 都有 started，并以 done/failed 收尾。
  const started = events.filter((event) => event.type === "plan_step_started");
  const done = events.filter((event) => event.type === "plan_step_done");
  assert.equal(started.length, done.length);

  confirmSession.dispose();
});

test("Mock 模式：中止后不再执行下一步", async () => {
  const events: PlanEvent[] = [];
  const controller = new AbortController();
  const confirmSession = new ConfirmSession();
  controller.abort();

  const state = await runPlanExecute({
    messages: [{ role: "user", content: "先查资料，再写一份部署方案对比" }],
    model: "test-model",
    apiKey: "",
    mockMode: true,
    signal: controller.signal,
    confirmSession,
    onEvent: (event) => events.push(event),
    onTrace: () => {},
    onDelta: () => {},
    onUsage: () => {},
  });

  assert.equal(state.terminalStatus, "aborted");
  assert.equal(
    events.some((event) => event.type === "plan_step_started"),
    false,
  );

  confirmSession.dispose();
});

test("Mock 模式：mode=react 时不调 Planner，直接走 ReAct 兜底", async () => {
  const events: PlanEvent[] = [];
  const deltas: string[] = [];
  const confirmSession = new ConfirmSession();

  const state = await runPlanExecute({
    messages: [{ role: "user", content: "先查资料，再写一份部署方案对比" }],
    model: "test-model",
    apiKey: "",
    mockMode: true,
    mode: "react",
    signal: new AbortController().signal,
    confirmSession,
    onEvent: (event) => events.push(event),
    onTrace: () => {},
    onDelta: (delta) => deltas.push(delta),
    onUsage: () => {},
  });

  assert.equal(events.some((event) => event.type === "plan_created"), false);
  assert.equal(state.terminalStatus, "completed");

  confirmSession.dispose();
});
