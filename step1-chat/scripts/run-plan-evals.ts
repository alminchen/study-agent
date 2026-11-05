/**
 * Plan-and-Execute 离线评测（步骤 11）。
 *
 * 用法：
 *   node --import tsx scripts/run-plan-evals.ts
 *   node --import tsx scripts/run-plan-evals.ts --id plan-order-steps
 *   node --import tsx scripts/run-plan-evals.ts --compare   （需要真实模型）
 *
 * 默认模式是**离线 Mock**：不调模型、不调真实工具，用预置剧本跑完整张图，
 * 再按规则判分。跑的是图与状态机，不是模型质量，所以可以进 CI。
 *
 * --compare 模式才打真实模型：同一个任务分别跑 ReAct 与 Plan-and-Execute，
 * 输出对比表（模型调用次数 / 工具调用次数 / 首字延迟 / 总延迟 / 成功率）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type {
  PlanEvalDataset,
  PlanEvalExample,
  PlanEvalExpect,
  PlanEvalMockPlan,
} from "../evals/types.js";
import { createChatStream } from "../server/chat.js";
import { MockStepExecutor } from "../server/plan-execute/mock.js";
import { runPlanExecute } from "../server/routes/chatPlan.js";
import type { StepExecutor } from "../server/plan-execute/executor.js";
import type { FinalReplier } from "../server/plan-execute/finalReply.js";
import { runPlanGraph, type PlanTraceEvent } from "../server/plan-execute/graph.js";
import type { Planner } from "../server/plan-execute/planner.js";
import type { Replanner } from "../server/plan-execute/replan.js";
import type {
  Plan,
  PlanErrorCode,
  PlanEvent,
  PlanRouteReason,
  PlanStep,
  PlanToolName,
  ResolvedMode,
} from "../server/plan-execute/types.js";
import { ConfirmSession } from "../server/react/confirmGate.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(root, "evals", "dataset-plan.json");

/* ---------------- 数据集读取 ---------------- */

async function loadDataset(): Promise<PlanEvalDataset> {
  const raw = await readFile(datasetPath, "utf8");
  return JSON.parse(raw) as PlanEvalDataset;
}

function parseArgs(argv: string[]): { ids: string[]; compare: boolean; verbose: boolean } {
  const ids: string[] = [];
  let compare = false;
  let verbose = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--id" && argv[index + 1]) {
      ids.push(argv[++index]);
    } else if (argv[index] === "--compare") {
      compare = true;
    } else if (argv[index] === "--verbose") {
      verbose = true;
    }
  }
  return { ids, compare, verbose };
}

/* ---------------- Mock 组件 ---------------- */

/** 路由类用例没给 mockPlan 时用的默认计划：一个只读工具步 + 一个总结步。 */
const DEFAULT_PLAN: PlanEvalMockPlan = {
  goal: "完成多步任务",
  steps: [
    {
      id: "step_1",
      title: "查询天气",
      action: "调用 getWeather 获取天气",
      doneWhen: "拿到天气结果",
      tools: ["getWeather"],
    },
    {
      id: "step_2",
      title: "汇总结果",
      action: "把结果汇总成一句话",
      doneWhen: "输出总结",
      tools: [],
    },
  ],
};

function toPlan(mock: PlanEvalMockPlan): Plan {
  return {
    goal: mock.goal,
    steps: mock.steps.map(
      (step): PlanStep => ({
        id: step.id,
        title: step.title,
        action: step.action,
        doneWhen: step.doneWhen,
        tools: [...step.tools] as PlanToolName[],
      }),
    ),
  };
}

/** Mock 最终回答：只复述真实完成的步骤，不假装执行过没跑的步骤。 */
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

/** 永远失败的执行器：用于「Re-plan 之后仍然失败」的上限场景。 */
function alwaysFailExecutor(failNumber: number, code: PlanErrorCode): StepExecutor {
  return {
    async runStep(context) {
      const startedAt = Date.now();
      const stepNumber = context.index + 1;
      if (stepNumber !== failNumber) {
        return {
          stepId: context.step.id,
          status: "done",
          summary: `步骤 ${stepNumber} 完成：${context.step.title}`,
          toolsCalled: [],
          startedAt,
          finishedAt: Date.now(),
        };
      }
      return {
        stepId: context.step.id,
        status: "failed",
        summary: `步骤 ${stepNumber} 持续失败`,
        toolsCalled: [],
        errorCode: code,
        startedAt,
        finishedAt: Date.now(),
      };
    },
  };
}

/** Re-plan 的 Mock：直接给一份新计划，是否被采纳仍由 validateReplanCandidate 判定。 */
function mockReplanner(nextPlan: Plan): Replanner {
  return {
    async replan(context) {
      return {
        kind: "replanned",
        revision: context.revision + 1,
        plan: nextPlan,
        reason: "tool_temporary_failure",
        note: `步骤 ${context.failedStep.id} 失败，已重新规划`,
      };
    },
  };
}

interface ScenarioSetup {
  plan: Plan;
  searchDocs: boolean;
  executor: StepExecutor;
  replanner?: Replanner;
  maxModelCalls?: number;
  /** 这一步做完后立刻中止。 */
  abortAfterDone?: string;
  /** 需要确认的步骤给什么答复。 */
  confirmAction?: "allow" | "deny";
}

/**
 * 按剧本装配 Mock 组件。
 *
 * 每个场景只改该场景关心的那一处（失败步骤、确认步骤、预算上限……），
 * 其余保持「一切正常」，这样失败时能一眼看出是哪条约束生效。
 */
function buildScenario(example: PlanEvalExample): ScenarioSetup {
  const mock = example.mockPlan ?? DEFAULT_PLAN;
  const plan = toPlan(mock);

  switch (example.scenario) {
    case "invalid-plan":
      // 知识库开着，计划里的 searchDocs 才合法；这样非法点只剩 search_web。
      return { plan, searchDocs: true, executor: new MockStepExecutor() };
    case "confirm-denied":
      return {
        plan,
        searchDocs: true,
        executor: new MockStepExecutor({ confirmSteps: [2] }),
        confirmAction: "deny",
      };
    case "replan-once":
      return {
        plan,
        searchDocs: false,
        executor: new MockStepExecutor({ failSteps: [2] }),
        replanner: mockReplanner(plan),
      };
    case "replan-limit":
      // 同一步持续失败：第二次失败时已达 Re-plan 上限，应直接终止。
      return {
        plan,
        searchDocs: false,
        executor: alwaysFailExecutor(2, "tool_failed"),
        replanner: mockReplanner(plan),
      };
    case "final-reply":
      // 第二步失败后重规划，新计划丢掉「汇总结果」这一步：
      // 最终回答只能引用真正跑过的 step_1 / step_2。
      return {
        plan,
        searchDocs: false,
        executor: new MockStepExecutor({ failSteps: [2] }),
        replanner: mockReplanner({ goal: plan.goal, steps: plan.steps.slice(0, 2) }),
      };
    case "abort":
      return {
        plan,
        searchDocs: false,
        executor: new MockStepExecutor(),
        abortAfterDone: "step_1",
      };
    case "budget":
      // 预算只够规划（1 次），第 1 步走不了。
      return {
        plan,
        searchDocs: false,
        executor: new MockStepExecutor(),
        maxModelCalls: 1,
      };
    default:
      return { plan, searchDocs: false, executor: new MockStepExecutor() };
  }
}

/* ---------------- 单条评测 ---------------- */

interface Observation {
  mode: ResolvedMode | null;
  reasonCode: PlanRouteReason | null;
  plannerCalled: boolean;
  planVisible: boolean;
  reactFallbackCalled: boolean;
  stepOrder: string[];
  startedSteps: string[];
  doneSteps: string[];
  maxSteps: number;
  replanCount: number;
  replanned: boolean;
  errorCode: PlanErrorCode | null;
  fallbackReason: PlanErrorCode | null;
  finalStatus: string;
  finalText: string;
}

function emptyObservation(): Observation {
  return {
    mode: null,
    reasonCode: null,
    plannerCalled: false,
    planVisible: false,
    reactFallbackCalled: false,
    stepOrder: [],
    startedSteps: [],
    doneSteps: [],
    maxSteps: 0,
    replanCount: 0,
    replanned: false,
    errorCode: null,
    fallbackReason: null,
    finalStatus: "",
    finalText: "",
  };
}

async function runExample(example: PlanEvalExample): Promise<Observation> {
  const setup = buildScenario(example);
  const observation = emptyObservation();
  const controller = new AbortController();
  const confirmSession = new ConfirmSession(`eval-${example.id}`);

  const planner: Planner = {
    async plan() {
      observation.plannerCalled = true;
      return { kind: "plan", plan: setup.plan };
    },
  };

  const onEvent = (event: PlanEvent) => {
    switch (event.type) {
      case "plan_route":
        observation.mode = event.mode;
        observation.reasonCode = event.reasonCode;
        break;
      case "plan_created":
        observation.planVisible = true;
        observation.stepOrder = event.plan.steps.map((step) => step.id);
        observation.maxSteps = event.plan.steps.length;
        break;
      case "plan_step_started":
        observation.startedSteps.push(event.stepId);
        break;
      case "plan_step_done":
        observation.doneSteps.push(event.stepId);
        if (setup.abortAfterDone && setup.abortAfterDone === event.stepId) {
          controller.abort();
        }
        break;
      case "plan_step_failed":
        // 只记步骤级失败（stepId 非空）：计划级失败是后果，不是根因。
        if (event.stepId && !observation.errorCode) observation.errorCode = event.code;
        break;
      case "plan_replanned":
        observation.replanned = true;
        observation.stepOrder = event.plan.steps.map((step) => step.id);
        break;
      case "plan_fallback":
        observation.fallbackReason = event.reasonCode;
        break;
      case "plan_finished":
        observation.finalStatus = event.status;
        break;
      default:
        break;
    }
  };

  const onTrace = (event: PlanTraceEvent) => {
    if (event.type === "pending_confirm" && setup.confirmAction) {
      // 模拟前端点「拒绝」：让 wait() 先把 pending 登记上。
      const action = setup.confirmAction;
      setTimeout(() => confirmSession.resolve(event.toolCallId, action), 0);
    }
  };

  try {
    const state = await runPlanGraph({
      messages: example.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      model: "mock-model",
      apiKey: "mock-key",
      searchDocs: setup.searchDocs,
      signal: controller.signal,
      confirmSession,
      planner,
      executor: setup.executor,
      finalReplier: mockFinalReplier,
      replanner: setup.replanner,
      reactFallback: {
        run: async () => {
          observation.reactFallbackCalled = true;
        },
      },
      onEvent,
      onTrace,
      onDelta: (delta) => {
        observation.finalText += delta;
      },
      maxModelCalls: setup.maxModelCalls,
    });
    observation.replanCount = state.replanCount;
    observation.finalStatus = state.terminalStatus;
  } finally {
    confirmSession.dispose();
  }

  return observation;
}

/* ---------------- 判分 ---------------- */

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function scoreExample(example: PlanEvalExample, observation: Observation): string[] {
  const reasons: string[] = [];
  const expect: PlanEvalExpect = example.expect;

  if (expect.mode !== undefined && observation.mode !== expect.mode) {
    reasons.push(`mode: 期望 ${expect.mode}，实际 ${observation.mode}`);
  }
  if (expect.reasonCode !== undefined && observation.reasonCode !== expect.reasonCode) {
    reasons.push(`reasonCode: 期望 ${expect.reasonCode}，实际 ${observation.reasonCode}`);
  }
  if (expect.plannerCalled !== undefined && observation.plannerCalled !== expect.plannerCalled) {
    reasons.push(`plannerCalled: 期望 ${expect.plannerCalled}，实际 ${observation.plannerCalled}`);
  }
  if (expect.planVisible !== undefined && observation.planVisible !== expect.planVisible) {
    reasons.push(`planVisible: 期望 ${expect.planVisible}，实际 ${observation.planVisible}`);
  }
  if (
    expect.reactFallbackCalled !== undefined &&
    observation.reactFallbackCalled !== expect.reactFallbackCalled
  ) {
    reasons.push(
      `reactFallbackCalled: 期望 ${expect.reactFallbackCalled}，实际 ${observation.reactFallbackCalled}`,
    );
  }
  if (expect.maxSteps !== undefined && observation.maxSteps > expect.maxSteps) {
    reasons.push(`maxSteps: 实际 ${observation.maxSteps} > 期望上限 ${expect.maxSteps}`);
  }
  if (expect.stepOrder && !sameList(observation.stepOrder, expect.stepOrder)) {
    reasons.push(
      `stepOrder: 期望 ${expect.stepOrder.join("→")}，实际 ${observation.stepOrder.join("→")}`,
    );
  }
  if (expect.startedSteps && !sameList(observation.startedSteps, expect.startedSteps)) {
    reasons.push(
      `startedSteps: 期望 ${expect.startedSteps.join("→")}，实际 ${observation.startedSteps.join("→")}`,
    );
  }
  if (expect.doneSteps && !sameList(observation.doneSteps, expect.doneSteps)) {
    reasons.push(
      `doneSteps: 期望 ${expect.doneSteps.join("→")}，实际 ${observation.doneSteps.join("→")}`,
    );
  }
  if (expect.finalStatus !== undefined && observation.finalStatus !== expect.finalStatus) {
    reasons.push(`finalStatus: 期望 ${expect.finalStatus}，实际 ${observation.finalStatus}`);
  }
  if (expect.replanCount !== undefined && observation.replanCount !== expect.replanCount) {
    reasons.push(`replanCount: 期望 ${expect.replanCount}，实际 ${observation.replanCount}`);
  }
  if (expect.replanned !== undefined && observation.replanned !== expect.replanned) {
    reasons.push(`replanned: 期望 ${expect.replanned}，实际 ${observation.replanned}`);
  }
  if (expect.errorCode !== undefined && observation.errorCode !== expect.errorCode) {
    reasons.push(`errorCode: 期望 ${expect.errorCode}，实际 ${observation.errorCode}`);
  }
  if (expect.fallbackReason !== undefined && observation.fallbackReason !== expect.fallbackReason) {
    reasons.push(`fallbackReason: 期望 ${expect.fallbackReason}，实际 ${observation.fallbackReason}`);
  }

  if (expect.finalReplyOnlyDone) {
    const mock = example.mockPlan ?? DEFAULT_PLAN;
    const done = new Set(observation.doneSteps);
    for (const step of mock.steps) {
      const mentioned = observation.finalText.includes(step.title);
      if (!done.has(step.id) && mentioned) {
        reasons.push(`finalReply 提到了未执行的 ${step.id}（${step.title}）`);
      }
      if (done.has(step.id) && !mentioned) {
        reasons.push(`finalReply 缺少已完成的 ${step.id}（${step.title}）`);
      }
    }
  }
  for (const excluded of expect.finalReplyExcludes ?? []) {
    if (observation.finalText.includes(excluded)) {
      reasons.push(`finalReply 命中禁则「${excluded}」`);
    }
  }

  return reasons;
}

/* ---------------- 覆盖检查（任务文档要求的 10 条） ---------------- */

const REQUIRED_COVERAGE: Array<{ requirement: string; ids: string[] }> = [
  { requirement: "简单问题不调用 Planner", ids: ["simple-greeting"] },
  { requirement: "复杂问题计划步骤有序", ids: ["plan-order-steps"] },
  { requirement: "计划步骤数不超过 6", ids: ["plan-too-many-steps", "plan-order-steps"] },
  { requirement: "非法计划回退 ReAct", ids: ["plan-invalid-tool"] },
  { requirement: "空计划回退 ReAct", ids: ["plan-empty"] },
  { requirement: "第二步工具失败后最多 Re-plan 一次", ids: ["plan-replan-once", "plan-replan-limit"] },
  { requirement: "用户拒绝确认后不 Re-plan", ids: ["plan-confirm-denied"] },
  { requirement: "中止后不执行下一步", ids: ["plan-abort-after-first-step"] },
  { requirement: "模型调用预算耗尽后停止", ids: ["plan-model-budget-exhausted"] },
  { requirement: "最终回答只引用已执行步骤", ids: ["plan-final-reply-only-executed"] },
];

function checkCoverage(dataset: PlanEvalDataset): string[] {
  const ids = new Set(dataset.map((example) => example.id));
  return REQUIRED_COVERAGE.filter((item) => item.ids.some((id) => !ids.has(id))).map(
    (item) => `缺少用例：${item.requirement}`,
  );
}

/* ---------------- 对比模式（真实模型） ---------------- */

interface Metrics {
  modelCalls: number;
  toolCalls: number;
  firstTokenMs: number | null;
  totalMs: number;
  ok: boolean;
  output: string;
}

async function measureReact(example: PlanEvalExample): Promise<Metrics> {
  const startedAt = Date.now();
  let firstTokenMs: number | null = null;
  let output = "";
  let modelCalls = 0;
  let toolCalls = 0;
  try {
    await createChatStream({
      messages: example.messages,
      model: process.env.LLM_MODEL,
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      forceMock: false,
      searchDocs: false,
      onDelta: (delta) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        output += delta;
      },
      onTrace: (event) => {
        if (event.type === "tool_call") toolCalls += 1;
      },
      onUsage: () => {
        modelCalls += 1;
      },
    });
  } catch (error) {
    return {
      modelCalls,
      toolCalls,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    modelCalls,
    toolCalls,
    firstTokenMs,
    totalMs: Date.now() - startedAt,
    ok: output.trim().length > 0,
    output,
  };
}

async function measurePlan(
  example: PlanEvalExample,
): Promise<Metrics & { planVisible: boolean }> {
  const startedAt = Date.now();
  let firstTokenMs: number | null = null;
  let output = "";
  let modelCalls = 0;
  let toolCalls = 0;
  let planVisible = false;
  const controller = new AbortController();
  const confirmSession = new ConfirmSession(`compare-${example.id}`);
  try {
    await runPlanExecute({
      messages: example.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      model: process.env.LLM_MODEL ?? "deepseek-chat",
      // 强制走计划模式：对比表要看的是「同任务下两条链路」的差异。
      mode: "plan",
      searchDocs: false,
      apiKey: process.env.LLM_API_KEY ?? "",
      baseUrl: process.env.LLM_BASE_URL,
      mockMode: false,
      signal: controller.signal,
      confirmSession,
      planId: `plan_compare_${example.id}`,
      onEvent: (event) => {
        if (event.type === "plan_created") planVisible = true;
      },
      onTrace: (event) => {
        if (event.type === "tool_call") toolCalls += 1;
      },
      onDelta: (delta) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        output += delta;
      },
      onUsage: () => {
        modelCalls += 1;
      },
    });
  } catch (error) {
    return {
      modelCalls,
      toolCalls,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      planVisible,
    };
  }
  return {
    modelCalls,
    toolCalls,
    firstTokenMs,
    totalMs: Date.now() - startedAt,
    ok: output.trim().length > 0,
    output,
    planVisible,
  };
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value}ms`;
}

async function runCompare(dataset: PlanEvalDataset): Promise<void> {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    console.error("eval:plan --compare 需要 LLM_API_KEY，且 MOCK_MODE 不能为 1。");
    process.exit(1);
  }

  const tasks = dataset.filter((example) => example.expected === "plan");
  console.log(`ReAct vs Plan-and-Execute 对比：${tasks.length} 个任务（真实模型，串行）\n`);
  console.log("| 任务 | 链路 | 模型调用 | 工具调用 | 首字延迟 | 总延迟 | 成功 | 计划可见 |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | :---: | :---: |");

  for (const task of tasks) {
    const react = await measureReact(task);
    const plan = await measurePlan(task);
    const label = task.messages.at(-1)?.content.slice(0, 20) ?? task.id;
    console.log(
      `| ${label} | ReAct | ${react.modelCalls} | ${react.toolCalls} | ${formatMs(react.firstTokenMs)} | ${formatMs(react.totalMs)} | ${react.ok ? "✓" : "✗"} | 否 |`,
    );
    console.log(
      `| ${label} | Plan | ${plan.modelCalls} | ${plan.toolCalls} | ${formatMs(plan.firstTokenMs)} | ${formatMs(plan.totalMs)} | ${plan.ok ? "✓" : "✗"} | ${plan.planVisible ? "是" : "否"} |`,
    );
  }
}

/* ---------------- 入口 ---------------- */

async function main() {
  const { ids, compare, verbose } = parseArgs(process.argv.slice(2));
  const dataset = await loadDataset();

  if (compare) {
    await runCompare(dataset);
    return;
  }

  let examples = dataset;
  if (ids.length > 0) {
    examples = examples.filter((example) => ids.includes(example.id));
    if (examples.length === 0) {
      console.error(`未找到 id：${ids.join(", ")}`);
      process.exit(1);
    }
  }

  console.log(`eval:plan  共 ${examples.length} 条（离线 Mock，不打真实模型）\n`);

  const missing = checkCoverage(dataset);
  for (const item of REQUIRED_COVERAGE) {
    const ok = missing.every((message) => !message.includes(item.requirement));
    console.log(`  ${ok ? "✓" : "✗"} ${item.requirement} → ${item.ids.join("、")}`);
  }
  if (missing.length > 0) {
    console.log("");
    for (const message of missing) console.log(`  ! ${message}`);
  }
  console.log("");

  let passed = 0;
  for (const example of examples) {
    const observation = await runExample(example);
    const reasons = scoreExample(example, observation);
    const status = reasons.length === 0 ? "PASS" : "FAIL";
    if (reasons.length === 0) passed += 1;
    console.log(
      `${example.id.padEnd(32)} ${example.scenario.padEnd(16)} ${status}` +
        (reasons.length > 0 ? `  ${reasons.join("  ")}` : ""),
    );
    if (verbose) {
      console.log(`  ${JSON.stringify(observation)}`);
    }
  }

  console.log(`\n${passed}/${examples.length} passed`);
  process.exit(passed === examples.length && missing.length === 0 ? 0 : 1);
}

await main();
