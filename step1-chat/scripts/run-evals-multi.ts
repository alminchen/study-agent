/**
 * /api/chat/multi 多 Agent 回归评测：固定问句 + 路由 & 工具判分。
 *
 * 用法：
 *   npm run eval:multi
 *   npm run eval:multi -- --id multi-weather-only
 *
 * 与 run-evals.ts（单 Agent）独立，走 compileMultiAgentGraph 直接调用图。
 * 需要 LLM_API_KEY；MOCK_MODE=1 时工具不会真跑，结果不可信。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { MultiAgentEvalDataset, MultiAgentEvalExample, MultiAgentEvalRunResult } from "../evals/types.js";
import { compileMultiAgentGraph } from "../server/multi-agent/graph.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(root, "evals", "dataset-multi.json");

// ============================================================
// 参数解析
// ============================================================

function parseArgs(argv: string[]): { ids: string[] } {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id" && argv[i + 1]) {
      ids.push(argv[++i]);
    }
  }
  return { ids };
}

// ============================================================
// 数据集加载
// ============================================================

async function loadDataset(): Promise<MultiAgentEvalDataset> {
  const raw = await readFile(datasetPath, "utf8");
  return JSON.parse(raw) as MultiAgentEvalDataset;
}

// ============================================================
// 执行单条用例：编译图 → invoke → 收集结果
// ============================================================

async function runExample(example: MultiAgentEvalExample): Promise<MultiAgentEvalRunResult> {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  try {
    const graph = compileMultiAgentGraph();
    const result = await graph.invoke({
      userMessage: example.messages[example.messages.length - 1].content,
      apiKey,
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL,
      signal: undefined,
      routeDecision: null,
      workerResults: [],
      finalOutput: null,
    });

    // 从 state 中提取路由决策和工具调用记录
    const routedWorkers = result.routeDecision?.workers.map((w: { name: string }) => w.name) ?? [];
    const tools = result.workerResults.flatMap((wr: { toolsCalled: string[] }) => wr.toolsCalled);

    return {
      id: example.id,
      output: result.finalOutput ?? "",
      routedWorkers,
      tools,
      error: null,
    };
  } catch (caught) {
    return {
      id: example.id,
      output: "",
      routedWorkers: [],
      tools: [],
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

// ============================================================
// 判分：验证路由 + 工具 + 回复内容
// ============================================================

function evaluateRun(
  run: MultiAgentEvalRunResult,
  expect: MultiAgentEvalExample["expect"],
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 是否出错
  if (expect.mustSucceed !== false && run.error) {
    reasons.push(`出错: ${run.error}`);
  }

  // 路由验证：Supervisor 应该分配给哪些 Worker
  if (expect.routeIncludes) {
    for (const w of expect.routeIncludes) {
      if (!run.routedWorkers.includes(w)) {
        reasons.push(`路由缺少: ${w}`);
      }
    }
  }
  if (expect.routeExcludes) {
    for (const w of expect.routeExcludes) {
      if (run.routedWorkers.includes(w)) {
        reasons.push(`路由不应包含: ${w}`);
      }
    }
  }

  // 工具验证：Worker 执行过程中应该/不应该调用哪些工具
  if (expect.toolsInclude) {
    for (const t of expect.toolsInclude) {
      if (!run.tools.includes(t)) {
        reasons.push(`工具缺少: ${t}`);
      }
    }
  }
  if (expect.toolsExclude) {
    for (const t of expect.toolsExclude) {
      if (run.tools.includes(t)) {
        reasons.push(`工具不应调用: ${t}`);
      }
    }
  }

  // 回复内容验证：不得包含某些子串
  if (expect.mustNotMatch) {
    for (const s of expect.mustNotMatch) {
      if (run.output.includes(s)) {
        reasons.push(`回复含禁止子串: "${s}"`);
      }
    }
  }

  return { pass: reasons.length === 0, reasons };
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    console.error("eval:multi 需要 LLM_API_KEY，且 MOCK_MODE 不能为 1。");
    process.exit(1);
  }

  const { ids } = parseArgs(process.argv.slice(2));
  const dataset = await loadDataset();
  let examples = dataset.examples;

  if (ids.length > 0) {
    examples = examples.filter((row) => ids.includes(row.id));
    if (examples.length === 0) {
      console.error(`未找到 id：${ids.join(", ")}`);
      process.exit(1);
    }
  }

  console.log(`eval:multi  共 ${examples.length} 条（串行，每条可能数十秒）\n`);

  let passed = 0;
  for (const example of examples) {
    process.stdout.write(`${example.id} … `);
    const run = await runExample(example);
    const verdict = evaluateRun(run, example.expect);

    if (verdict.pass) {
      passed += 1;
      console.log("PASS");
    } else {
      console.log(`FAIL  ${verdict.reasons.join("  ")}`);
      console.log(`       route: ${run.routedWorkers.join(", ") || "无"}`);
      console.log(`       tools: ${run.tools.join(" → ") || "无"}`);
      const preview = run.output.replace(/\s+/g, " ").slice(0, 120);
      if (preview) {
        console.log(`       output: ${preview}${run.output.length > 120 ? "…" : ""}`);
      }
    }
  }

  console.log(`\n${passed}/${examples.length} passed`);
  process.exit(passed === examples.length ? 0 : 1);
}

await main();
