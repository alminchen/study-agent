import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PLAN_STEPS,
  MAX_PLAN_GOAL,
  MAX_STEP_ACTION,
  MAX_STEP_DONE_WHEN,
  MAX_STEP_TITLE,
  MAX_STEP_TOOLS,
  planJsonLength,
  validatePlan,
} from "./schema.js";

/** 工厂只提供合法基线；每个用例单独破坏一个约束，避免用例之间耦合。 */
function step(index: number, tools: string[] = []) {
  return {
    id: `step_${index}`,
    title: `步骤 ${index}`,
    action: "执行一个明确动作",
    doneWhen: "得到可检查的结果",
    tools,
  };
}

test("合法计划通过校验，并保留步骤工具列表", () => {
  const result = validatePlan({
    goal: "比较三种部署方案并给出建议",
    steps: [step(1, ["searchDocs"]), step(2)],
  });
  assert.deepEqual(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.steps.length, 2);
    assert.deepEqual(result.plan.steps[0]?.tools, ["searchDocs"]);
  }
});

test("空计划返回 plan_empty", () => {
  const result = validatePlan({ goal: "目标", steps: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "plan_empty");
});

test("超过 6 步返回 plan_too_long", () => {
  const result = validatePlan({
    goal: "目标",
    steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => step(index + 1)),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "plan_too_long");
});

test("重复 id 与不连续 id 返回 invalid_plan", () => {
  const duplicate = validatePlan({ goal: "目标", steps: [step(1), step(1)] });
  const gap = validatePlan({ goal: "目标", steps: [step(1), step(3)] });
  assert.equal(duplicate.ok, false);
  assert.equal(gap.ok, false);
});

test("空字段与超长字段返回 invalid_plan", () => {
  const emptyTitle = validatePlan({
    goal: "目标",
    steps: [{ ...step(1), title: "" }],
  });
  const longTitle = validatePlan({
    goal: "目标",
    steps: [{ ...step(1), title: "标".repeat(MAX_STEP_TITLE + 1) }],
  });
  const longAction = validatePlan({
    goal: "目标",
    steps: [{ ...step(1), action: "做".repeat(MAX_STEP_ACTION + 1) }],
  });
  const emptyDoneWhen = validatePlan({
    goal: "目标",
    steps: [{ ...step(1), doneWhen: "" }],
  });
  assert.equal(emptyTitle.ok, false);
  assert.equal(longTitle.ok, false);
  assert.equal(longAction.ok, false);
  assert.equal(emptyDoneWhen.ok, false);
});

test("非法工具名与工具数量超限返回 invalid_plan", () => {
  const badTool = validatePlan({ goal: "目标", steps: [step(1, ["deleteFile"])] });
  const tooMany = validatePlan({
    goal: "目标",
    steps: [step(1, Array.from({ length: MAX_STEP_TOOLS + 1 }, () => "getWeather"))],
  });
  assert.equal(badTool.ok, false);
  assert.equal(tooMany.ok, false);
});

test("计划 JSON 超过 4000 字符返回 plan_too_long", () => {
  // 直接构造超长 JSON 字符串，绕开 strict schema 的未知字段拒绝，
  // 确保长度检查发生在形状检查之前。
  const parsed = JSON.parse(
    JSON.stringify({
      goal: "标".repeat(MAX_PLAN_GOAL),
      steps: [step(1), step(2)],
      pad: "x".repeat(4200),
    }),
  ) as unknown;
  assert.ok(planJsonLength(parsed) > 4000);
  const result = validatePlan(parsed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "plan_too_long");
});

test("searchDocs 开启时必须包含检索步骤", () => {
  const result = validatePlan(
    { goal: "目标", steps: [step(1, ["getWeather"])] },
    { requireSearchDocs: true },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_plan");
});

test("知识库未开启时用到 searchDocs 返回 invalid_plan", () => {
  // 未开启知识库 → 可用工具里没有 searchDocs，计划用到它就是不可执行。
  const result = validatePlan(
    { goal: "目标", steps: [step(1, ["searchDocs"])] },
    { availableTools: ["getWeather", "getCurrentTime", "draft_message"] },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid_plan");
});

test("知识库开启时 searchDocs 仍可用", () => {
  const result = validatePlan(
    { goal: "目标", steps: [step(1, ["searchDocs"])] },
    { requireSearchDocs: true, availableTools: ["getWeather", "searchDocs"] },
  );
  assert.equal(result.ok, true);
});

test("同一工具在步骤里重复出现时归一化为一次", () => {
  // tools 是白名单：重复项会让模型看到两个同名工具并重复调用。
  const result = validatePlan({
    goal: "目标",
    steps: [step(1, ["getWeather", "getWeather"])],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.plan.steps[0]?.tools, ["getWeather"]);
});
