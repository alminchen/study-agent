import assert from "node:assert/strict";
import test from "node:test";
import { createRealExecutor } from "./executor.js";
import { createConsecutiveFailureTracker } from "../react/toolFailure.js";
import type { ProviderChoice } from "../react/types.js";
import type { Plan, PlanStep, PlanToolName } from "./types.js";

const PLAN: Plan = {
  goal: "查询广州天气",
  steps: [
    { id: "step_1", title: "查天气", action: "查询广州天气", doneWhen: "拿到温度", tools: ["getWeather"] },
    { id: "step_2", title: "总结", action: "总结结果", doneWhen: "有一句话总结", tools: [] },
    { id: "step_3", title: "起草消息", action: "起草一条消息", doneWhen: "拿到草稿", tools: ["draft_message"] },
  ],
};

function step(index: number, tools: PlanToolName[] = []): PlanStep {
  return PLAN.steps[index] ? { ...PLAN.steps[index]!, tools } : ({} as PlanStep);
}

/** 用固定回复序列驱动模型；每轮取一个 choice，用完则复用最后一个。 */
function stubFetch(choices: ProviderChoice[]) {
  let index = 0;
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const choice = choices[Math.min(index, choices.length - 1)];
    index += 1;
    calls += 1;
    return new Response(
      JSON.stringify({
        choices: [choice],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    get calls() {
      return calls;
    },
  };
}

function toolCall(name: string, args: unknown, id = "call_1") {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function textChoice(content: string): ProviderChoice {
  return { finish_reason: "stop", message: { role: "assistant", content } };
}

async function run(
  stepIndex: number,
  choices: ProviderChoice[],
  options: {
    signal?: AbortSignal;
    confirmSession?: import("../react/confirmGate.js").ConfirmSession;
    onTrace?: import("../react/types.js").ToolTraceHandler;
  } = {},
) {
  const stub = stubFetch(choices);
  try {
    const executor = createRealExecutor({ apiKey: "test-key" });
    return await executor.runStep({
      plan: PLAN,
      step: step(stepIndex, PLAN.steps[stepIndex]?.tools ?? []),
      index: stepIndex,
      planId: "plan_test",
      revision: 0,
      model: "deepseek-chat",
      apiKey: "test-key",
      confirmSession: options.confirmSession,
      failures: createConsecutiveFailureTracker(),
      signal: options.signal,
      onTrace: options.onTrace,
    });
  } finally {
    stub.restore();
  }
}

test("无工具步骤：模型直接给摘要，步骤成功", async () => {
  const result = await run(1, [textChoice("已总结：今天多云，28 度。")]);
  assert.equal(result.status, "done");
  assert.equal(result.stepId, "step_2");
  assert.match(result.summary, /已总结/);
  assert.deepEqual(result.toolsCalled, []);
});

test("只读工具步骤：先调工具再出摘要", async () => {
  const result = await run(0, [
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getWeather", { city: "广州" })] } },
    textChoice("广州今天 28 度，多云。"),
  ]);
  assert.equal(result.status, "done");
  assert.deepEqual(result.toolsCalled, ["getWeather"]);
  assert.match(result.summary, /28 度/);
});

test("模型调用本步骤未允许的工具被拒绝，不执行任何工具", async () => {
  const result = await run(0, [
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getCurrentTime", {})] } },
    textChoice("不该走到这里"),
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "tool_not_allowed");
  assert.deepEqual(result.toolsCalled, []);
});

test("工具失败后步骤进入失败状态", async () => {
  // 火星天气：工具自身返回 error，属于只读工具失败。
  const result = await run(0, [
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getWeather", { city: "火星" })] } },
    textChoice("不该走到这里"),
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "tool_failed");
});

test("用户拒绝确认后返回 confirm_denied，且不被改写", async () => {
  const { ConfirmSession } = await import("../react/confirmGate.js");
  const session = new ConfirmSession("test-confirm");

  const result = await run(
    2,
    [
      { message: { role: "assistant", content: null, tool_calls: [toolCall("draft_message", { to: "同事", body: "hi" })] } },
      textChoice("不该走到这里"),
    ],
    {
      confirmSession: session,
      // 模拟前端：收到 pending_confirm 才回拒绝。setTimeout 让 wait() 先登记 pending。
      onTrace: (event) => {
        if (event.type === "pending_confirm") {
          setTimeout(() => session.resolve(event.toolCallId, "deny"), 0);
        }
      },
    },
  );
  session.dispose();
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "confirm_denied");
  assert.match(result.summary, /用户拒绝/);
});

test("abort 后不再发起下一次模型调用", async () => {
  // 场景一：工具跑完后被中止 → 不能再问第二轮模型。
  const controller = new AbortController();
  const stub = stubFetch([
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getWeather", { city: "广州" })] } },
    textChoice("不该走到这里"),
  ]);
  try {
    const executor = createRealExecutor({ apiKey: "test-key" });
    const result = await executor.runStep({
      plan: PLAN,
      step: step(0, ["getWeather"]),
      index: 0,
      planId: "plan_test",
      revision: 0,
      model: "deepseek-chat",
      apiKey: "test-key",
      failures: createConsecutiveFailureTracker(),
      signal: controller.signal,
      // 工具结果回来的瞬间用户点了停止。
      onTrace: (event) => {
        if (event.type === "tool_result") controller.abort();
      },
    });
    assert.equal(result.status, "aborted");
    assert.equal(result.errorCode, "aborted");
    assert.equal(stub.calls, 1, "中止后不应再发起第二次模型调用");
  } finally {
    stub.restore();
  }

  // 场景二：调用前已 abort，直接返回 aborted，且不发请求。
  const aborted = new AbortController();
  aborted.abort();
  const stub2 = stubFetch([textChoice("不该走到这里")]);
  try {
    const executor = createRealExecutor({ apiKey: "test-key" });
    const result = await executor.runStep({
      plan: PLAN,
      step: step(0, ["getWeather"]),
      index: 0,
      planId: "plan_test",
      revision: 0,
      model: "deepseek-chat",
      apiKey: "test-key",
      failures: createConsecutiveFailureTracker(),
      signal: aborted.signal,
    });
    assert.equal(result.status, "aborted");
    assert.equal(result.errorCode, "aborted");
    assert.equal(stub2.calls, 0, "已中止时不应发出任何模型请求");
  } finally {
    stub2.restore();
  }
});

test("第二轮仍要调工具时返回 step_turn_limit", async () => {
  const result = await run(0, [
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getWeather", { city: "广州" })] } },
    { message: { role: "assistant", content: null, tool_calls: [toolCall("getWeather", { city: "深圳" })] } },
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "step_turn_limit");
});

test("步骤里重复声明同一工具时，只给模型一份工具定义", async () => {
  // 计划里写 ["getWeather", "getWeather"] 表达「查两个城市」，
  // 但工具定义只能有一份，否则模型会看到两个同名函数并重复调用。
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "已查询" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const executor = createRealExecutor({ apiKey: "test-key" });
    await executor.runStep({
      plan: PLAN,
      step: { ...PLAN.steps[0]!, tools: ["getWeather", "getWeather"] },
      index: 0,
      planId: "plan_test",
      revision: 0,
      model: "deepseek-chat",
      apiKey: "test-key",
      failures: createConsecutiveFailureTracker(),
    });
    const names = (JSON.parse(bodies[0] ?? "{}").tools ?? []).map(
      (item: { function: { name: string } }) => item.function.name,
    );
    assert.deepEqual(names, ["getWeather"], "同名工具只应出现一次");
  } finally {
    globalThis.fetch = original;
  }
});
