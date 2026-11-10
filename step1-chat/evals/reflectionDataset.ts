/**
 * 加载并校验 Reflection 评测数据集。
 *
 * 与 Judge 数据集同一条原则：校验失败直接抛错，不静默跳过。
 * 反思评测的分母就是这份数据集，一条坏样本会让「反思到底帮不帮得上忙」
 * 这个结论整体失真。
 *
 * 数据集只描述「问题 + 事实 + 预期」，不预置答案：
 * 初版答案由基线链路真实生成，反思链路拿同一份初版去改，
 * 两边比的是同一件事，差异只来自反思本身。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATASET_PATH = path.join(ROOT, "evals", "dataset-reflection.json");

/** 预期行为：期望触发重写 / 期望不重写。 */
export type ReflectionExpectation = "rewrite" | "no_rewrite";

/** 一条反思评测样本。 */
export interface ReflectionEvalExample {
  id: string;
  /** 用户原始问题。 */
  question: string;
  /** 本次会话已知的事实；重写只能引用这里的内容。 */
  toolFacts: string;
  /** 人工标注说明，写清这条样本在测什么。 */
  notes: string;
  /** 预期反思链路的行为，用于统计「预期与实际是否一致」。 */
  expected: ReflectionExpectation;
}

/** 数据集最少条数：低于这个数算出来的均值没有意义。 */
export const REFLECTION_MIN_SIZE = 8;

function fail(message: string): never {
  throw new Error(`dataset-reflection 校验失败：${message}`);
}

function checkExample(
  raw: unknown,
  index: number,
  seen: Set<string>,
): ReflectionEvalExample {
  if (typeof raw !== "object" || raw === null) {
    fail(`第 ${index + 1} 条不是对象`);
  }
  const row = raw as Record<string, unknown>;

  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) fail(`第 ${index + 1} 条缺少 id`);
  if (seen.has(id)) fail(`id 重复：${id}`);
  seen.add(id);

  const question = typeof row.question === "string" ? row.question.trim() : "";
  if (!question) fail(`${id} 的 question 为空`);

  const toolFacts = typeof row.toolFacts === "string" ? row.toolFacts.trim() : "";
  if (!toolFacts) fail(`${id} 的 toolFacts 为空`);

  const notes = typeof row.notes === "string" ? row.notes.trim() : "";
  if (!notes) fail(`${id} 缺少 notes`);

  const expected = row.expected as ReflectionExpectation;
  if (expected !== "rewrite" && expected !== "no_rewrite") {
    fail(`${id} 的 expected 非法：${String(row.expected)}`);
  }

  return { id, question, toolFacts, notes, expected };
}

/** 读取并校验数据集文件。 */
export async function loadReflectionDataset(
  filePath: string = DATASET_PATH,
): Promise<ReflectionEvalExample[]> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (caught) {
    fail(
      `JSON 解析失败：${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }

  const rows = (parsed as { examples?: unknown })?.examples;
  if (!Array.isArray(rows)) {
    fail("顶层缺少 examples 数组");
  }

  const seen = new Set<string>();
  const examples = rows.map((row, index) => checkExample(row, index, seen));

  if (examples.length < REFLECTION_MIN_SIZE) {
    fail(`数据集只有 ${examples.length} 条，少于 ${REFLECTION_MIN_SIZE} 条`);
  }

  return examples;
}
