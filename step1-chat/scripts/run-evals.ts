/**
 * /api/chat 单 Agent 回归评测：固定问句 + 规则判分。
 *
 * 用法：
 *   npm run eval:chat
 *   npm run eval:chat -- --id time-now
 *
 * 多 Agent 评测请用 run-evals-multi.ts（npm run eval:multi）。
 *
 * 建议评测时 LANGCHAIN_TRACING_V2=false，少刷 LangSmith 额度。
 * 需要 LLM_API_KEY；MOCK_MODE=1 时工具不会真跑，结果不可信。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { evaluateRun } from "../evals/evaluators.js";
import type { EvalDataset, EvalExample, EvalRunResult } from "../evals/types.js";
import { createChatStream } from "../server/chat.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = path.join(root, "evals", "dataset.json");

function parseArgs(argv: string[]): { ids: string[] } {
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id" && argv[i + 1]) {
      ids.push(argv[++i]);
    }
  }
  return { ids };
}

async function loadDataset(): Promise<EvalDataset> {
  const raw = await readFile(datasetPath, "utf8");
  return JSON.parse(raw) as EvalDataset;
}

async function runExample(example: EvalExample): Promise<EvalRunResult> {
  const tools: string[] = [];
  let output = "";
  let error: string | null = null;

  try {
    await createChatStream({
      messages: example.messages,
      searchDocs: example.searchDocs,
      model: process.env.LLM_MODEL,
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      forceMock: false,
      onDelta: (delta) => {
        output += delta;
      },
      onTrace: (event) => {
        if (event.type === "tool_call") {
          tools.push(event.name);
        }
      },
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return {
    id: example.id,
    output,
    tools,
    error,
  };
}

async function main() {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    console.error("eval:chat 需要 LLM_API_KEY，且 MOCK_MODE 不能为 1。");
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

  console.log(`eval:chat  共 ${examples.length} 条（串行，每条可能数十秒）\n`);

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
      if (run.tools.length > 0) {
        console.log(`       tools: ${run.tools.join(" → ")}`);
      }
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
