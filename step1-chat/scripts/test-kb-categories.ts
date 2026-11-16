/**
 * 步骤 6 自测：分类——建类、上传选类、按类检索。
 *
 * 覆盖验收标准：
 *   1. 建分类 + 列分类；同名建类去重（分类是替换与过滤的边界，必须唯一）
 *   2. 两个分类各放一篇主题明显不同的文档，worker 入库后都可检索
 *   3. 分类 A 的特有原句，在分类 B 下检索不会成为高分答案（库侧硬过滤）
 *   4. 命中结果带所属分类与来源文档（category / source 字段可见）
 *   5. 未选分类的上传被拒绝，提示「请选择分类」
 *
 * 用法：npx tsx scripts/test-kb-categories.ts
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { embed } from "../server/rag/embedding.js";
import { createCategory, listCategories } from "../server/kb/categoryStore.js";
import { removeChunksByDoc } from "../server/kb/chunkStore.js";
import { getTask } from "../server/kb/taskStore.js";
import { uploadOriginal, validateUpload, UPLOAD_DIR } from "../server/kb/uploader.js";
import { removeVectorsByDoc } from "../server/kb/vectorStore.js";
import { runWorkerOnce } from "../server/kb/worker.js";
import type { KbTask } from "../server/kb/types.js";

const KB_DIR = path.join(process.cwd(), "data", "kb");

const CATEGORY_A = "面试笔记";
const CATEGORY_B = "日记";

const DOC_A_MD = `# 面试笔记：动态知识库

动态知识库的写入顺序是先切片再向量化，全部完成后才能被检索。
上传必须带分类，未选分类的文件不允许入库。

## 分类边界

分类是检索的硬边界，过滤必须发生在检索层。`;

const DOC_B_MD = `# 日记：今天吃了什么

今天中午吃了牛肉面，晚上打算喝粥。
心情不错，散步了半小时。`;

const createdTasks: KbTask[] = [];
const createdCategories: string[] = [];

async function cleanupTaskData(task: KbTask): Promise<void> {
  const raw = JSON.parse(await readFile(path.join(KB_DIR, "tasks.json"), "utf-8")) as KbTask[];
  await writeFile(
    path.join(KB_DIR, "tasks.json"),
    JSON.stringify(raw.filter((row) => row.id !== task.id), null, 2),
    "utf-8",
  );
  await removeChunksByDoc(task.docId);
  await removeVectorsByDoc(task.docId);
  await rm(path.join(UPLOAD_DIR, task.docId), { recursive: true, force: true });
}

async function cleanupCategories(): Promise<void> {
  const raw = JSON.parse(
    await readFile(path.join(KB_DIR, "categories.json"), "utf-8"),
  ) as Array<{ id: string; name: string; createdAt: number }>;
  await writeFile(
    path.join(KB_DIR, "categories.json"),
    JSON.stringify(raw.filter((row) => !createdCategories.includes(row.name)), null, 2),
    "utf-8",
  );
}

async function main(): Promise<void> {
  console.log("1. 建两个分类 + 列表可见，同名建类去重");
  const catA = await createCategory(CATEGORY_A);
  const catB = await createCategory(CATEGORY_B);
  createdCategories.push(CATEGORY_A, CATEGORY_B);
  const again = await createCategory(CATEGORY_A);
  if (again.id !== catA.id) {
    throw new Error("同名分类应复用同一 id（去重失效）");
  }
  const names = (await listCategories()).map((cat) => cat.name);
  if (!names.includes(CATEGORY_A) || !names.includes(CATEGORY_B)) {
    throw new Error(`分类列表缺少已建分类，实际 ${names.join(",")}`);
  }
  console.log(`  ok 分类：${names.join(" / ")}，同名去重生效`);

  console.log("2. 两个分类各入库一篇主题不同的文档");
  const docA = await uploadOriginal({
    filename: "kb-interview.md",
    category: CATEGORY_A,
    content: Buffer.from(DOC_A_MD).toString("base64"),
  });
  createdTasks.push(docA);
  const docB = await uploadOriginal({
    filename: "diary.md",
    category: CATEGORY_B,
    content: Buffer.from(DOC_B_MD).toString("base64"),
  });
  createdTasks.push(docB);
  // 每轮 worker 只推进一条任务；两条任务共需要 4 轮（各切块 + 各入库）。
  for (let i = 0; i < 4; i++) {
    await runWorkerOnce();
  }
  const taskA = (await getTask(docA.id))!;
  const taskB = (await getTask(docB.id))!;
  if (taskA.status !== "searchable" || taskB.status !== "searchable") {
    throw new Error(`两篇都应 searchable，实际 ${taskA.status} / ${taskB.status}`);
  }
  console.log("  ok 两篇都入库完成");

  console.log("3. 问分类 A 的原句：A 下高分命中，B 下不应成为高分答案");
  const [queryVec] = await embed(["分类是检索的硬边界，过滤必须发生在检索层。"]);
  const hitA = (await listHitsWithQuery(queryVec, CATEGORY_A, 3))[0];
  const hitBAll = await listHitsWithQuery(queryVec, CATEGORY_B, 3);
  if (!hitA || hitA.score < 0.7) {
    throw new Error(`A 下原句应高分命中，实际 ${hitA?.score ?? "无"}`);
  }
  const hitB = hitBAll[0];
  if (hitB && hitB.score >= hitA.score - 0.2) {
    throw new Error(`B 下不应接近 A 的命中分数：A ${hitA.score} vs B ${hitB.score}`);
  }
  if (hitB && hitB.text.includes("分类是检索的硬边界")) {
    throw new Error("B 分类库中不应出现 A 的块");
  }
  console.log(`  ok A 下 ${hitA.score.toFixed(3)}（命中来源 ${hitA.source}）；B 下最多 ${hitB?.score.toFixed(3) ?? "无命中"}`);

  console.log("4. 命中结果带分类与来源字段");
  const hit = hitA;
  if (hit.category !== CATEGORY_A || !hit.source.endsWith("kb-interview.md")) {
    throw new Error(`命中应带分类与来源，实际 category=${hit.category} source=${hit.source}`);
  }
  console.log(`  ok category=${hit.category} source=${hit.source} docId=${hit.docId.slice(0, 12)}…`);

  console.log("5. 未选分类的上传被拒绝，提示请选择分类");
  let rejected = false;
  let message = "";
  try {
    await validateUpload({ filename: "no-cat.md", content: "x", category: "" });
  } catch (error) {
    rejected = true;
    message = error instanceof Error ? error.message : String(error);
  }
  if (!rejected || !message.includes("请选择分类")) {
    throw new Error(`未选分类应被拒绝并提示，实际 ${message}`);
  }
  console.log(`  ok 拒绝并提示「${message}」`);

  console.log("步骤 6 自测全部通过 ✓");
}

/** 复用 searchByCategory 的检索逻辑：针对分类取 TopK。 */
async function listHitsWithQuery(
  queryVec: number[],
  category: string,
  topK: number,
): Promise<Array<{ category: string; source: string; docId: string; seq: number; text: string; score: number }>> {
  const { searchByCategory } = await import("../server/kb/vectorStore.js");
  const hits = await searchByCategory(category, queryVec, topK);
  return hits.map(({ record, score }) => ({
    category: record.category,
    source: record.source,
    docId: record.docId,
    seq: record.seq,
    text: record.text,
    score,
  }));
}

try {
  await main();
} finally {
  for (const task of createdTasks) {
    await cleanupTaskData(task);
  }
  await cleanupCategories();
}
