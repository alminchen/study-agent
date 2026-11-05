import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanSystemPrompt, createEmitPlanTool } from "./prompts.js";
import type { ToolSchema } from "../tools/types.js";
import { planAvailableTools } from "./types.js";

/** 取 emit_plan 里 steps[].tools 的枚举；schema 是 Record<string, unknown>，需要显式收窄。 */
function toolEnum(tool: ToolSchema): string[] {
  const steps = tool.function.parameters.properties.steps as {
    items: { properties: { tools: { items: { enum: string[] } } } };
  };
  return steps.items.properties.tools.items.enum;
}

test("知识库未开启：提示词不出现 searchDocs", () => {
  const prompt = buildPlanSystemPrompt({
    goal: "产出一份自驾游路线方案",
    searchDocs: false,
    availableTools: planAvailableTools(false),
    revision: 0,
  });
  assert.ok(!prompt.includes("searchDocs"), "未开启知识库时不该把 searchDocs 写进工具目录");
  assert.match(prompt, /没有开启知识库检索/);
});

test("知识库开启：提示词给出 searchDocs 且要求至少一步检索", () => {
  const prompt = buildPlanSystemPrompt({
    goal: "产出一份自驾游路线方案",
    searchDocs: true,
    availableTools: planAvailableTools(true),
    revision: 0,
  });
  assert.match(prompt, /searchDocs/);
  assert.match(prompt, /必须至少有一个步骤/);
});

test("emit_plan 的工具枚举按可用工具裁剪", () => {
  assert.ok(
    !toolEnum(createEmitPlanTool(planAvailableTools(false))).includes("searchDocs"),
    "枚举里不该有 searchDocs",
  );
  assert.ok(
    toolEnum(createEmitPlanTool(planAvailableTools(true))).includes("searchDocs"),
  );
});
