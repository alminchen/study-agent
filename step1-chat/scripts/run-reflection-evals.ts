/**
 * Reflection 评测脚本：同一份初版答案，走两条链路对比。
 *
 * 要回答的问题只有一个：反思到底帮不帮得上忙，代价是多少。
 * 口径设计：
 * - 基线：同一个模型、同一份工具事实，直接回答一次。
 * - Reflection：拿基线那份初版答案当 draft，跑完整反思链路（评分 → 可选重写 → 重评）。
 * - 两边比的是同一件事，差异只来自反思本身，不掺杂采样差异。
 *
 * Mock 约束：
 * - --mock / MOCK_MODE=1 / 没有 LLM_API_KEY 时走 mock。
 * - mock 的模型调用全部写在脚本内，不进 server/，也不碰网络。
 * - mock 产出的质量分、token、成本都不具备结论意义，
 *   报告顶部会打横幅说明，mock 只用来验证链路是否跑通。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import {
  loadReflectionDataset,
  type ReflectionEvalExample,
  type ReflectionExpectation,
} from "../evals/reflectionDataset.js";
import {
  averageScore,
  critique,
  shouldRewriteByThreshold,
} from "../server/reflection/critic.js";
import { revise } from "../server/reflection/revise.js";
import type { Critique, CritiqueScores } from "../server/reflection/types.js";
import {
  createReflectionModelCaller,
  runReflectionPipeline,
  type ReflectionEvent,
} from "../server/routes/chatReflection.js";
import { getRuntimeConfig } from "../server/runtimeConfig.js";
import {
  UsageAccumulator,
  bindUsageCallback,
} from "../server/usage/accumulator.js";
import { formatCostUsd, mergeUsage } from "../server/usage/pricing.js";
import type { TokenUsage } from "../server/usage/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPORT_PATH = path.join(
  ROOT,
  "evals",
  "reflection-comparison-report.md",
);

dotenv.config({ path: path.join(ROOT, ".env.local") });
dotenv.config({ path: path.join(ROOT, ".env") });

type RunMode = "mock" | "live";

interface CliOptions {
  limit: number | null;
  out: string;
  mock: boolean;
  id: string | null;
}

interface BaselineResult {
  draft: string;
  durationMs: number;
  usage: TokenUsage;
  costUsd: number;
  llmCalls: number;
}

interface ReflectionResult {
  durationMs: number;
  usage: TokenUsage;
  costUsd: number;
  llmCalls: number;
  initialAverage: number | null;
  finalAverage: number | null;
  initialScores: CritiqueScores | null;
  finalScores: CritiqueScores | null;
  issueCount: number;
  shouldRewrite: boolean;
  adopted: boolean;
  skipReason: string | null;
}

interface SampleOutcome {
  id: string;
  question: string;
  notes: string;
  expected: ReflectionExpectation;
  baseline: BaselineResult;
  reflection: ReflectionResult;
  behaviorMatched: boolean;
  error: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: null,
    out: DEFAULT_REPORT_PATH,
    mock: false,
    id: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const takeValue = (inline: string | undefined): string | null => {
      // 只有 "--key=value" 这种写了值的形态才算内联值，
      // "--key value" 要从下一个参数里取。
      if (inline !== undefined && inline !== "") return inline;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) return null;
      index += 1;
      return next;
    };

    if (arg === "--mock") {
      options.mock = true;
      continue;
    }
    if (arg.startsWith("--limit")) {
      const value = takeValue(arg.slice("--limit".length).replace(/^=/, ""));
      const parsed = Number.parseInt(value ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = parsed;
      continue;
    }
    if (arg.startsWith("--out")) {
      const value = takeValue(arg.slice("--out".length).replace(/^=/, ""));
      if (value) {
        options.out = path.isAbsolute(value)
          ? value
          : path.resolve(ROOT, value);
      }
      continue;
    }
    if (arg.startsWith("--id")) {
      const value = takeValue(arg.slice("--id".length).replace(/^=/, ""));
      if (value) options.id = value;
      continue;
    }
  }

  return options;
}

function resolveRunMode(options: CliOptions): RunMode {
  if (options.mock) return "mock";
  return getRuntimeConfig().mockMode ? "mock" : "live";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index] as T, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------- mock 模型

/** 从提示词里截出某个【标记】段落。 */
function extractSection(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const rest = text.slice(start + marker.length);
  const end = rest.search(/\n【/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** 稳定散列：同一问题永远得到同一份 mock 答案。 */
function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100003;
  }
  return hash;
}

function mockBaselineAnswer(example: ReflectionEvalExample): string {
  const target = 80 + (hashOf(example.question) % 100);
  const lead = "针对这个问题，可以先给出结论，再补充依据与注意事项：";
  const filler =
    "先看结论本身是否直接回答了问题，再看依据是否都能在给定材料里找到，" +
    "最后确认适用范围有没有说清楚，避免把局部经验当成普遍规律使用。";
  let body = lead;
  while (body.length < target) {
    body += filler;
  }
  return body.slice(0, target);
}

function mockCriticAnswer(user: string): string {
  const draft = extractSection(user, "【待评分的最终答案】");
  const length = draft.length;

  let scores: CritiqueScores;
  if (length < 100) {
    scores = { relevance: 3, completeness: 3, groundedness: 4, clarity: 3 };
  } else if (length < 150) {
    scores = { relevance: 4, completeness: 3, groundedness: 4, clarity: 4 };
  } else {
    scores = { relevance: 4, completeness: 4, groundedness: 4, clarity: 4 };
  }

  const shouldRewrite = Object.values(scores).some((value) => value <= 3);
  return JSON.stringify({
    scores,
    issues: shouldRewrite
      ? [
          {
            dimension: "completeness",
            detail: "mock：答案偏短，依据展开不足",
          },
        ]
      : [],
    shouldRewrite,
    revisionInstructions: shouldRewrite
      ? "补充结论的依据与适用边界，不要引入新事实"
      : "无需重写",
    reason: shouldRewrite ? "mock：存在低分维度" : "mock：各维度均达标",
  });
}

function mockReviseAnswer(user: string): string {
  const draft = extractSection(user, "【原答案】");
  const suffix =
    "补充说明：上面给出的结论只在给定材料覆盖的范围内成立，" +
    "落地前建议再核对口径与前提，遇到材料未覆盖的情况应当另行确认。";
  return `${draft}\n\n${suffix}`;
}

// ---------------------------------------------------------------- 基线链路

const BASELINE_SYSTEM = [
  "你是一个乐于助人的助手。请根据给定的用户问题和已知事实，直接给出最终答案。",
  "要求：先给结论，再补充依据与注意事项；不要罗列无关内容，不要编造未提供的事实。",
].join("\n");

function buildBaselineUser(example: ReflectionEvalExample): string {
  return [
    "【用户问题】",
    example.question,
    "",
    "【工具事实】",
    example.toolFacts,
    "",
    "请直接输出最终答案正文。",
  ].join("\n");
}

// ---------------------------------------------------------------- 单条评测

function scoresOf(critiqueResult: Critique | null): CritiqueScores | null {
  if (!critiqueResult || critiqueResult.status !== "ok") return null;
  return critiqueResult.scores;
}

function averageOf(critiqueResult: Critique | null): number | null {
  const scores = scoresOf(critiqueResult);
  return scores ? averageScore(scores) : null;
}

async function evaluateSample(
  example: ReflectionEvalExample,
  mode: RunMode,
  model: string,
): Promise<SampleOutcome> {
  const config = getRuntimeConfig();
  const baselineAcc = new UsageAccumulator();
  const criticAcc = new UsageAccumulator();
  const reviseAcc = new UsageAccumulator();

  let error: string | null = null;

  // ---- 基线：同模型同事实，直接回答一次 ----
  const baselineStart = Date.now();
  let draft = "";
  try {
    if (mode === "mock") {
      draft = mockBaselineAnswer(example);
    } else {
      const caller = createReflectionModelCaller({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model,
        onUsage: bindUsageCallback(baselineAcc, "askModel", model),
      });
      draft = await caller({
        system: BASELINE_SYSTEM,
        user: buildBaselineUser(example),
        signal: AbortSignal.timeout(120_000),
      });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const baselineDuration = Date.now() - baselineStart;

  const baseline: BaselineResult = {
    draft,
    durationMs: baselineDuration,
    usage: baselineAcc.mergedUsage(),
    costUsd: baselineAcc.estimatedCostUsd(),
    llmCalls: baselineAcc.llmCalls,
  };

  // ---- 反思链路：拿同一份 draft 走评分 → 重写 → 重评 ----
  const events: ReflectionEvent[] = [];
  const critiqueCaller =
    mode === "mock"
      ? async (request: { system: string; user: string }) =>
          mockCriticAnswer(request.user)
      : createReflectionModelCaller({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model,
          onUsage: bindUsageCallback(criticAcc, "critic", model),
        });
  const reviseCaller =
    mode === "mock"
      ? async (request: { system: string; user: string }) =>
          mockReviseAnswer(request.user)
      : createReflectionModelCaller({
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model,
          onUsage: bindUsageCallback(reviseAcc, "revise", model),
        });

  const pipelineStart = Date.now();
  let pipelineResult = {
    finalDraft: draft,
    initial: null as Critique | null,
    revised: null as Critique | null,
    revisedDraft: null as string | null,
  };
  try {
    pipelineResult = await runReflectionPipeline({
      question: example.question,
      draft,
      toolFacts: example.toolFacts,
      mode: "enforce",
      // mock 也必须传 false，否则整条管线会被 mock_mode 直接短路。
      mockMode: false,
      critique: (input, options) =>
        critique(input, { callModel: critiqueCaller, onMeta: options.onMeta }),
      revise: (input, options) =>
        revise(input, { callModel: reviseCaller, onMeta: options.onMeta }),
      onEvent: (event) => events.push(event),
    });
  } catch (caught) {
    error = error ?? (caught instanceof Error ? caught.message : String(caught));
  }
  const pipelineDuration = Date.now() - pipelineStart;

  const initialScores = scoresOf(pipelineResult.initial);
  const finalScores =
    scoresOf(pipelineResult.revised) ?? initialScores;
  const initialAverage = averageOf(pipelineResult.initial);
  const finalAverage = averageOf(pipelineResult.revised) ?? initialAverage;
  const shouldRewrite =
    pipelineResult.initial !== null &&
    pipelineResult.initial.status === "ok"
      ? shouldRewriteByThreshold(pipelineResult.initial)
      : false;
  const adopted =
    pipelineResult.revisedDraft !== null &&
    pipelineResult.finalDraft === pipelineResult.revisedDraft;
  const scoredEvent = events.find(
    (event) => event.type === "reflection_scored",
  );
  const skippedEvent = events.find(
    (event) => event.type === "reflection_skipped",
  );
  const issueCount =
    scoredEvent && scoredEvent.type === "reflection_scored"
      ? scoredEvent.issues.length
      : 0;

  const reflectionUsage = mergeUsage([
    criticAcc.mergedUsage(),
    reviseAcc.mergedUsage(),
  ]);

  const reflection: ReflectionResult = {
    durationMs: pipelineDuration,
    usage: reflectionUsage,
    costUsd: criticAcc.estimatedCostUsd() + reviseAcc.estimatedCostUsd(),
    llmCalls: criticAcc.llmCalls + reviseAcc.llmCalls,
    initialAverage,
    finalAverage,
    initialScores,
    finalScores,
    issueCount,
    shouldRewrite,
    adopted,
    skipReason:
      skippedEvent && skippedEvent.type === "reflection_skipped"
        ? skippedEvent.reason
        : null,
  };

  const behaviorMatched =
    expectedMatches(example.expected, reflection.shouldRewrite);

  return {
    id: example.id,
    question: example.question,
    notes: example.notes,
    expected: example.expected,
    baseline,
    reflection,
    behaviorMatched,
    error,
  };
}

function expectedMatches(
  expected: ReflectionExpectation,
  shouldRewrite: boolean,
): boolean {
  return expected === "rewrite" ? shouldRewrite : !shouldRewrite;
}

// ---------------------------------------------------------------- 报告渲染

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmt(value: number | null): string {
  return value === null ? "-" : round(value, 2).toString();
}

function delta(base: number, next: number): string {
  const diff = next - base;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${round(diff, 2)}`;
}

function renderReport(
  mode: RunMode,
  model: string,
  outcomes: SampleOutcome[],
): string {
  const generatedAt = new Date().toISOString();
  const total = outcomes.length;
  const scored = outcomes.filter(
    (outcome) => outcome.reflection.finalAverage !== null,
  );

  const baselineQuality = mean(
    outcomes
      .map((outcome) => outcome.reflection.initialAverage)
      .filter((value): value is number => value !== null),
  );
  const reflectionQuality = mean(
    outcomes
      .map((outcome) => outcome.reflection.finalAverage)
      .filter((value): value is number => value !== null),
  );
  const baselineLatency = mean(
    outcomes.map((outcome) => outcome.baseline.durationMs),
  );
  const reflectionLatency = mean(
    outcomes.map((outcome) => outcome.reflection.durationMs),
  );
  const baselineTokens = mean(
    outcomes.map((outcome) => outcome.baseline.usage.totalTokens),
  );
  const reflectionTokens = mean(
    outcomes.map((outcome) => outcome.reflection.usage.totalTokens),
  );
  const baselineCost = mean(
    outcomes.map((outcome) => outcome.baseline.costUsd),
  );
  const reflectionCost = mean(
    outcomes.map((outcome) => outcome.reflection.costUsd),
  );

  const dimensionKeys: (keyof CritiqueScores)[] = [
    "relevance",
    "completeness",
    "groundedness",
    "clarity",
  ];
  const baselineDimensions = dimensionKeys.map((key) =>
    mean(
      outcomes
        .map((outcome) => outcome.reflection.initialScores?.[key])
        .filter((value): value is number => typeof value === "number"),
    ),
  );
  const reflectionDimensions = dimensionKeys.map((key) =>
    mean(
      outcomes
        .map((outcome) => outcome.reflection.finalScores?.[key])
        .filter((value): value is number => typeof value === "number"),
    ),
  );

  const rewriteCount = outcomes.filter(
    (outcome) => outcome.reflection.shouldRewrite,
  ).length;
  const adoptedCount = outcomes.filter((outcome) => outcome.reflection.adopted)
    .length;
  const matchedCount = outcomes.filter((outcome) => outcome.behaviorMatched).length;
  const skipCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    const reason = outcome.reflection.skipReason;
    if (!reason) continue;
    skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("# Reflection 对比评测报告");
  lines.push("");
  lines.push(
    `生成时间：${generatedAt} ｜ 运行模式：${mode} ｜ 模型：${model} ｜ 样本数：${total}`,
  );
  lines.push("");
  if (mode === "mock") {
    lines.push(
      "> ⚠️ **mock 运行，无质量结论**：本次所有模型输出由脚本内的固定规则生成，",
    );
    lines.push(
      "> 只用于验证评测链路是否跑通（数据加载 → 基线 → 评分 → 重写 → 重评 → 报告）。",
    );
    lines.push(
      "> 下表中的质量分、token、成本、延迟均不代表真实模型表现，不可用于决策。",
    );
    lines.push("");
  }
  lines.push("## 一、对比口径");
  lines.push("");
  lines.push(
    "- **基线**：同一个模型、同一份工具事实，直接回答一次（无反思）。",
  );
  lines.push(
    "- **Reflection**：拿基线那份初版答案当 draft，走完整链路（评分 → 可选重写 → 重评）。",
  );
  lines.push(
    "- 两边比的是同一件事，样本、事实、模型都相同，差异只来自反思本身。",
  );
  lines.push(
    "- 反思链路强制以 enforce 模式运行（改写必须可被采纳），否则测不出改写的真实收益。",
  );
  lines.push("");

  lines.push("## 二、四列对比（基线 vs Reflection vs 差值）");
  lines.push("");
  lines.push("| 指标 | 基线 | Reflection | 差值 |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(
    `| 质量分（均分 1~5） | ${fmt(baselineQuality)} | ${fmt(reflectionQuality)} | ${delta(baselineQuality, reflectionQuality)} |`,
  );
  lines.push(
    `| 延迟（ms，反思链路耗时） | ${fmt(baselineLatency)} | ${fmt(reflectionLatency)} | ${delta(baselineLatency, reflectionLatency)} |`,
  );
  lines.push(
    `| 端到端延迟（ms，基线+反思） | ${fmt(baselineLatency)} | ${fmt(baselineLatency + reflectionLatency)} | ${delta(baselineLatency, baselineLatency + reflectionLatency)} |`,
  );
  lines.push(
    `| Token（平均 totalTokens） | ${fmt(baselineTokens)} | ${fmt(reflectionTokens)} | ${delta(baselineTokens, reflectionTokens)} |`,
  );
  lines.push(
    `| 成本（平均 USD） | ${formatCostUsd(baselineCost)} | ${formatCostUsd(reflectionCost)} | ${formatCostUsd(reflectionCost - baselineCost)} |`,
  );
  lines.push("");
  lines.push(
    `> 端到端口径：用户真实等待 = 基线生成 + 反思链路，因此 Reflection 的用户侧成本是 ${formatCostUsd(baselineCost + reflectionCost)}（平均）。`,
  );
  lines.push("");

  lines.push("## 三、维度分对比");
  lines.push("");
  lines.push("| 维度 | 基线 | Reflection | 差值 |");
  lines.push("| --- | --- | --- | --- |");
  dimensionKeys.forEach((key, index) => {
    lines.push(
      `| ${key} | ${fmt(baselineDimensions[index])} | ${fmt(reflectionDimensions[index])} | ${delta(baselineDimensions[index] ?? 0, reflectionDimensions[index] ?? 0)} |`,
    );
  });
  lines.push("");

  lines.push("## 四、链路行为统计");
  lines.push("");
  lines.push(`- 触发重写（阈值判定）：${rewriteCount} / ${total}`);
  lines.push(`- 实际采纳修订稿：${adoptedCount} / ${total}`);
  lines.push(
    `- 预期与实际一致：${matchedCount} / ${total}（${total > 0 ? round((matchedCount / total) * 100, 1) : 0}%）`,
  );
  lines.push(
    `- 评分成功：${scored.length} / ${total}（失败样本不计入质量分均值）`,
  );
  lines.push("");
  lines.push("跳过原因分布：");
  lines.push("");
  if (skipCounts.size === 0) {
    lines.push("- 无跳过事件");
  } else {
    for (const [reason, count] of skipCounts) {
      lines.push(`- ${reason}：${count}`);
    }
  }
  lines.push("");

  lines.push("## 五、逐条明细");
  lines.push("");
  lines.push(
    "| id | 预期 | 触发重写 | 采纳 | 基线分 | 反思分 | 跳过原因 | 一致 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const outcome of outcomes) {
    lines.push(
      `| ${outcome.id} | ${outcome.expected} | ${outcome.reflection.shouldRewrite} | ${outcome.reflection.adopted} | ${fmt(outcome.reflection.initialAverage)} | ${fmt(outcome.reflection.finalAverage)} | ${outcome.reflection.skipReason ?? "-"} | ${outcome.behaviorMatched} |`,
    );
  }
  lines.push("");
  lines.push("样本说明：");
  lines.push("");
  for (const outcome of outcomes) {
    lines.push(`- ${outcome.id}：${outcome.notes}`);
  }
  lines.push("");

  lines.push("## 六、结论");
  lines.push("");
  if (mode === "mock") {
    lines.push(
      "- 本次为 mock 运行，只能确认链路可跑通，不能得出任何质量或成本结论。",
    );
    lines.push(
      "- 需要真实结论时，去掉 --mock 并配置 LLM_API_KEY 后重跑本脚本。",
    );
  } else {
    const qualityDelta = reflectionQuality - baselineQuality;
    if (qualityDelta > 0) {
      lines.push(
        `- 质量分提升 ${round(qualityDelta, 2)} 分，端到端延迟增加 ${fmt(reflectionLatency)} ms，平均多花 ${formatCostUsd(reflectionCost)}。`,
      );
    } else if (qualityDelta < 0) {
      lines.push(
        `- 质量分下降 ${round(-qualityDelta, 2)} 分，说明重写引入了新问题，应考虑收紧采纳条件。`,
      );
    } else {
      lines.push("- 质量分没有变化，说明本批样本没触发有效改写。");
    }
    lines.push(
      `- 触发重写 ${rewriteCount} 条、采纳 ${adoptedCount} 条，改写链路确实在工作。`,
    );
  }
  lines.push("");

  lines.push("## 七、口径与局限");
  lines.push("");
  lines.push(
    "- 质量分由同一个 Critic 模型给出，评分本身带主观性；基线分与反思分共用同一把尺子，",
  );
  lines.push("  因此两者可比，但绝对分数不能当作客观质量。");
  lines.push(
    "- Reflection 一列的质量分取最终稿分数（采纳修订稿时用重评分，否则用初评分）。",
  );
  lines.push(
    "- 延迟与成本不含网络抖动以外的前端渲染开销；端到端一列才接近用户真实等待。",
  );
  lines.push("- 数据集条数有限，结论只覆盖这批样本覆盖到的场景。");
  lines.push(
    "- mock 模式下的所有数值均由脚本规则生成，仅用于链路自检。",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const mode = resolveRunMode(options);
  const config = getRuntimeConfig();
  const model = config.model;

  let examples = await loadReflectionDataset();
  if (options.id) {
    examples = examples.filter((example) => example.id === options.id);
  }
  if (options.limit !== null) {
    examples = examples.slice(0, options.limit);
  }
  if (examples.length === 0) {
    throw new Error("没有可评测的样本");
  }

  console.log(
    `[reflection-evals] 模式=${mode} 模型=${model} 样本=${examples.length}`,
  );

  const outcomes = await mapWithConcurrency(
    examples,
    mode === "mock" ? 1 : 4,
    async (example) => {
      const outcome = await evaluateSample(example, mode, model);
      console.log(
        `[reflection-evals] ${outcome.id} 基线分=${fmt(outcome.reflection.initialAverage)} 反思分=${fmt(outcome.reflection.finalAverage)} 采纳=${outcome.reflection.adopted}`,
      );
      return outcome;
    },
  );

  const report = renderReport(mode, model, outcomes);
  await writeFile(options.out, report, "utf8");
  const relativeOut = path.relative(ROOT, options.out);
  console.log(
    `[reflection-evals] 报告已写入 ${relativeOut.startsWith("..") ? path.basename(options.out) : relativeOut}`,
  );
}

main().catch((error: unknown) => {
  console.error("[reflection-evals] 运行失败：", error);
  process.exitCode = 1;
});

