/**
 * 加载并校验 LLM-as-Judge 评测数据集。
 *
 * 校验失败直接抛错退出，不静默跳过——数据集是所有指标的唯一分母，
 * 一条坏样本就足以让 precision/recall 失去意义。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  JudgeCategory,
  JudgeEvalDataset,
  JudgeEvalExample,
  JudgeRisk,
  JudgeSplit,
  JudgeSurface,
} from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_PATH = path.join(ROOT, "evals", "judge-dataset.json");

const RISKS: JudgeRisk[] = ["none", "medium", "high"];
const SPLITS: JudgeSplit[] = ["dev", "test"];
const SURFACES: JudgeSurface[] = ["input", "output"];
const CATEGORIES: JudgeCategory[] = [
  "prompt_injection",
  "indirect_injection",
  "jailbreak",
  "role_play",
  "system_leak",
  "harmless_query",
  "code_review",
  "unsafe_output",
  "safe_output",
];

/** 每个类别必须落在哪一侧，防止 input 样本被当成 output 判。 */
const CATEGORY_SURFACE: Record<JudgeCategory, JudgeSurface> = {
  prompt_injection: "input",
  indirect_injection: "input",
  jailbreak: "input",
  role_play: "input",
  system_leak: "input",
  harmless_query: "input",
  code_review: "input",
  unsafe_output: "output",
  safe_output: "output",
};

/** 类别最低配额：低于下限说明覆盖面有缺口。 */
export const CATEGORY_MIN_QUOTA: Record<JudgeCategory, number> = {
  prompt_injection: 8,
  indirect_injection: 8,
  jailbreak: 6,
  role_play: 6,
  system_leak: 6,
  harmless_query: 12,
  code_review: 8,
  unsafe_output: 8,
  safe_output: 8,
};

/** 基准集（dev）最低条数，保证每次评测有足够分母。 */
export const DEV_MIN_SIZE = 40;

function fail(message: string): never {
  throw new Error(`judge-dataset 校验失败：${message}`);
}

function checkExample(raw: unknown, index: number, seen: Set<string>): JudgeEvalExample {
  if (typeof raw !== "object" || raw === null) {
    fail(`第 ${index + 1} 条不是对象`);
  }
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  if (!id) fail(`第 ${index + 1} 条缺少 id`);
  if (seen.has(id)) fail(`id 重复：${id}`);
  seen.add(id);

  if (typeof row.input !== "string" || row.input.trim() === "") {
    fail(`${id} 的 input 为空`);
  }
  if (typeof row.notes !== "string" || row.notes.trim() === "") {
    fail(`${id} 缺少 notes`);
  }

  const surface = row.surface as JudgeSurface;
  if (!SURFACES.includes(surface)) {
    fail(`${id} 的 surface 非法：${String(row.surface)}`);
  }

  const category = row.category as JudgeCategory;
  if (!CATEGORIES.includes(category)) {
    fail(`${id} 的 category 非法：${String(row.category)}`);
  }
  if (CATEGORY_SURFACE[category] !== surface) {
    fail(`${id} 的 category=${category} 与 surface=${surface} 不匹配`);
  }

  const expectedRisk = row.expectedRisk as JudgeRisk;
  if (!RISKS.includes(expectedRisk)) {
    fail(`${id} 的 expectedRisk 非法：${String(row.expectedRisk)}`);
  }

  const split = row.split as JudgeSplit;
  if (!SPLITS.includes(split)) {
    fail(`${id} 的 split 非法：${String(row.split)}`);
  }

  if (row.expectedRuleHits !== undefined) {
    if (!Array.isArray(row.expectedRuleHits)) {
      fail(`${id} 的 expectedRuleHits 不是数组`);
    }
    if (!row.expectedRuleHits.every((item) => typeof item === "string")) {
      fail(`${id} 的 expectedRuleHits 含非字符串元素`);
    }
  }

  return {
    id,
    split,
    input: row.input as string,
    surface,
    category,
    expectedRisk,
    expectedRuleHits: row.expectedRuleHits as string[] | undefined,
    notes: row.notes as string,
  };
}

/** 校验整份数据集的结构与配额。 */
export function validateJudgeDataset(examples: JudgeEvalExample[]): void {
  if (examples.length === 0) {
    fail("数据集为空");
  }

  const devCount = examples.filter((row) => row.split === "dev").length;
  if (devCount < DEV_MIN_SIZE) {
    fail(`基准集（dev）只有 ${devCount} 条，少于 ${DEV_MIN_SIZE} 条`);
  }

  const counts = new Map<JudgeCategory, number>();
  for (const row of examples) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }
  for (const [category, min] of Object.entries(CATEGORY_MIN_QUOTA) as [
    JudgeCategory,
    number,
  ][]) {
    const actual = counts.get(category) ?? 0;
    if (actual < min) {
      fail(`${category} 只有 ${actual} 条，低于配额下限 ${min} 条`);
    }
  }
}

/** 读取并校验数据集文件。 */
export async function loadJudgeDataset(
  filePath: string = DATASET_PATH,
): Promise<JudgeEvalExample[]> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    fail(`JSON 解析失败：${caught instanceof Error ? caught.message : String(caught)}`);
  }

  const rows = (parsed as JudgeEvalDataset)?.examples;
  if (!Array.isArray(rows)) {
    fail("顶层缺少 examples 数组");
  }

  const seen = new Set<string>();
  const examples = rows.map((row, index) => checkExample(row, index, seen));
  validateJudgeDataset(examples);
  return examples;
}
