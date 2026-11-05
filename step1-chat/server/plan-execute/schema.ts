import { z } from "zod";
import {
  PLAN_TOOL_NAMES,
  type Plan,
  type PlanErrorCode,
  type PlanStep,
  type PlanToolName,
} from "./types.js";

export const MAX_PLAN_STEPS = 6;
export const MAX_STEP_TOOLS = 3;
export const MAX_STEP_TITLE = 80;
export const MAX_STEP_ACTION = 300;
export const MAX_STEP_DONE_WHEN = 200;
export const MAX_PLAN_GOAL = 500;
export const MAX_PLAN_JSON_CHARS = 4000;

export const PlanStepSchema = z
  .object({
    id: z.string().regex(/^step_[1-6]$/),
    title: z.string().min(1).max(MAX_STEP_TITLE),
    action: z.string().min(1).max(MAX_STEP_ACTION),
    doneWhen: z.string().min(1).max(MAX_STEP_DONE_WHEN),
    // tools 是白名单语义：同一个工具列两遍没有意义，归一化时只保留一次。
    // 需要用不同参数多次调用同一工具，把说明写进 action。
    tools: z.array(z.enum(PLAN_TOOL_NAMES as unknown as [string, ...string[]])).max(MAX_STEP_TOOLS).default([]),
  })
  .strict();

export const PlanSchema = z
  .object({
    goal: z.string().min(1).max(MAX_PLAN_GOAL),
    steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
  })
  .strict();

export type PlanValidation =
  | { ok: true; plan: Plan }
  | { ok: false; code: PlanErrorCode; message: string };

export interface ValidatePlanOptions {
  /** 请求开启 searchDocs 时，计划必须包含一个使用 searchDocs 的步骤。 */
  requireSearchDocs?: boolean;
  /**
   * 本次请求可用的工具名。
   * 未列出的工具（如未开启知识库时的 searchDocs）出现在步骤里 → invalid_plan，
   * 不让不可执行的动作进入执行阶段。
   *
   * 不传则只按白名单校验形状：是否可用属于请求上下文，
   * 由知道该上下文的调用方（graph / planner / replan）显式传入。
   */
  availableTools?: PlanToolName[];
}

export function planJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fail(code: PlanErrorCode, message: string): PlanValidation {
  return { ok: false, code, message };
}

/** id 必须唯一，并按 step_1..step_6 顺序出现，否则无法与步骤结果对齐。 */
function validateSequentialIds(steps: PlanStep[]): string | null {
  const seen = new Set<string>();
  for (let index = 0; index < steps.length; index += 1) {
    const id = steps[index]?.id ?? "";
    if (seen.has(id)) return `步骤 id 重复：${id}`;
    seen.add(id);
    const expected = `step_${index + 1}`;
    if (id !== expected) return `步骤 id 必须连续，期望 ${expected}，实际 ${id}`;
  }
  return null;
}

/**
 * 计划校验的唯一入口：长度、形状、id 顺序、工具白名单、检索步骤。
 * 只返回稳定错误码，message 仅用于展示和诊断。
 */
export function validatePlan(raw: unknown, options: ValidatePlanOptions = {}): PlanValidation {
  if (planJsonLength(raw) > MAX_PLAN_JSON_CHARS) {
    return fail("plan_too_long", `计划 JSON 超过 ${MAX_PLAN_JSON_CHARS} 字符`);
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { steps?: unknown }).steps) &&
    (raw as { steps: unknown[] }).steps.length === 0
  ) {
    return fail("plan_empty", "计划不能为空");
  }

  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some(
      (issue) => issue.path[0] === "steps" && issue.code === "too_big",
    );
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .slice(0, 3)
      .join("; ");
    return fail(tooLong ? "plan_too_long" : "invalid_plan", detail);
  }

  const plan = parsed.data as Plan;

  // 工具白名单去重：重复项会让模型看到两个同名工具、重复调用，白白吃掉单步预算。
  for (const step of plan.steps) {
    step.tools = [...new Set(step.tools)];
  }

  const sequenceError = validateSequentialIds(plan.steps);
  if (sequenceError) return fail("invalid_plan", sequenceError);

  const available = options.availableTools ?? [...PLAN_TOOL_NAMES];
  const unavailable = plan.steps.flatMap((step) =>
    step.tools.filter((tool) => !available.includes(tool)).map((tool) => `${step.id}:${tool}`),
  );
  if (unavailable.length > 0) {
    return fail(
      "invalid_plan",
      `计划用到了本次不可用的工具：${unavailable.join("、")}（可用：${available.join("、")}）`,
    );
  }

  if (options.requireSearchDocs && !plan.steps.some((step) => step.tools.includes("searchDocs"))) {
    return fail("invalid_plan", "开启 searchDocs 时计划必须包含检索步骤");
  }

  return { ok: true, plan };
}
