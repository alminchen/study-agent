/**
 * 步骤 7 自测：下架、失败重试与列表页。
 *
 * 覆盖验收标准：
 *   1. 列表页能看出每篇文档的状态、分类、文件名、块数、更新时间，刷新不丢
 *   2. 删除文档后，该文档特有问句在该分类下检索结果为空（删除事务彻底）
 *   3. 制造一次失败 -> 点重试 -> 任务重新进入处理并完成，docId 不变、不重复建文档
 *
 * 用法：npx tsx scripts/test-kb-lifecycle.ts
 */
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { embed } from "../server/rag/embedding.js";
import { createCategory } from "../server/kb/categoryStore.js";
import {
  countChunksByDoc,
  removeChunksByDoc,
} from "../server/kb/chunkStore.js";
import {
  listTasks,
  removeTasksByDoc,
  retryTask,
  updateTask,
} from "../server/kb/taskStore.js";
import { uploadOriginal, UPLOAD_DIR } from "../server/kb/uploader.js";
import {
  countVectorsByDoc,
  removeVectorsByDoc,
  searchByCategory,
} from "../server/kb/vectorStore.js";
import { runWorkerOnce } from "../server/kb/worker.js";
import type { KbTask } from "../server/kb/types.js";

const KB_DIR = path.join(process.cwd(), "data", "kb");
const CATEGORY = "面试笔记";

const DOC_MD = `# 面试笔记：动态知识库

动态知识库的写入顺序是先切片再向量化，全部完成后才能被检索。
删除文档必须连向量一起删，否则幽灵块会继续污染检索结果。

## 特有句

本句是下架验收用的特有句子：删除后检索应为空。`;

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
  const category = await createCategory(CATEGORY);
  createdCategories.push(CATEGORY);

  console.log("1. 列表页：状态/分类/文件名/块数/更新时间齐全，刷新不丢");
  const uploaded = await uploadOriginal({
    filename: "kb-lifecycle.md",
    category: CATEGORY,
    content: Buffer.from(DOC_MD).toString("base64"),
  });
  createdTasks.push(uploaded);
  await runWorkerOnce(); // chunked
  await runWorkerOnce(); // searchable
  const task = (await listTasks()).find((row) => row.id === uploaded.id)!;
  if (task.status !== "searchable" || task.category !== CATEGORY || task.filename !== "kb-lifecycle.md") {
    throw new Error(`列表字段缺失：${JSON.stringify(task)}`);
  }
  if (task.chunkCount !== (await countChunksByDoc(uploaded.docId))) {
    throw new Error("列表块数应与块表实时一致");
  }
  if (!task.updatedAt) throw new Error("列表应带更新时间");
  const tasksAgain = await listTasks();
  if (!tasksAgain.some((row) => row.id === uploaded.id)) {
    throw new Error("刷新后任务应仍在（持久化）");
  }
  console.log(`  ok status=${task.status} 块数=${task.chunkCount} 刷新不丢`);

  console.log("2. 删除事务：向量/块/任务/原件全清，检索该文档特有句为空");
  const sentence = "本句是下架验收用的特有句子：删除后检索应为空。";
  const [queryVec] = await embed([sentence]);
  if ((await searchByCategory(CATEGORY, queryVec, 5)).length === 0) {
    throw new Error("删除前原句应能命中");
  }
  await removeVectorsByDoc(uploaded.docId);
  await removeChunksByDoc(uploaded.docId);
  await removeTasksByDoc(uploaded.docId);
  await rm(path.join(UPLOAD_DIR, uploaded.docId), { recursive: true, force: true });
  if ((await countVectorsByDoc(uploaded.docId)) !== 0) {
    throw new Error("向量未清干净");
  }
  if ((await countChunksByDoc(uploaded.docId)) !== 0) {
    throw new Error("块未清干净");
  }
  const remaining = (await listTasks()).filter((row) => row.docId === uploaded.docId);
  if (remaining.length !== 0) {
    throw new Error("任务记录未清干净");
  }
  let originalGone = false;
  try {
    await access(path.join(UPLOAD_DIR, uploaded.docId));
  } catch {
    originalGone = true;
  }
  if (!originalGone) throw new Error("磁盘原件未删除");
  const hits = await searchByCategory(CATEGORY, queryVec, 5);
  if (hits.length !== 0) {
    throw new Error(`删除后该文档特有句仍被召回：${hits[0].record.source}`);
  }
  createdTasks.pop(); // 已通过删除事务清理，不再单独 cleanup
  console.log("  ok 向量/块/任务/原件全清，检索为空");

  console.log("3. 失败重试：制造失败 -> 重试 -> 重新完成，docId 不变");
  const retried = await uploadOriginal({
    filename: "kb-retry.md",
    category: CATEGORY,
    content: Buffer.from(DOC_MD).toString("base64"),
  });
  createdTasks.push(retried);
  const docIdBefore = retried.docId;
  await runWorkerOnce(); // chunked
  await updateTask(retried.id, {
    status: "failed",
    stage: "chunk",
    error: "模拟切片失败",
  });
  const failed = (await listTasks()).find((row) => row.id === retried.id)!;
  if (failed.status !== "failed") throw new Error("应已置为 failed");
  const retriedTask = await retryTask(retried.id);
  if (!retriedTask || retriedTask.status !== "queued" || retriedTask.error !== null) {
    throw new Error(`重试应复位 queued 并清空 error，实际 ${retriedTask?.status}`);
  }
  if (retriedTask.docId !== docIdBefore) {
    throw new Error("重试不应更换 docId");
  }
  await runWorkerOnce(); // queued -> chunking -> chunked
  await runWorkerOnce(); // chunked -> searchable
  const done = (await listTasks()).find((row) => row.id === retried.id)!;
  if (done.status !== "searchable" || done.docId !== docIdBefore) {
    throw new Error(`重试后应 searchable 且 docId 不变，实际 ${done.status}`);
  }
  const docCount = (await listTasks()).filter((row) => row.docId === docIdBefore).length;
  if (docCount !== 1) {
    throw new Error(`重试不应产生重复任务记录，实际 ${docCount} 条`);
  }
  console.log("  ok failed -> queued -> searchable，docId 不变、无重复记录");

  console.log("步骤 7 自测全部通过 ✓");
}

try {
  await main();
} finally {
  for (const task of createdTasks) {
    await cleanupTaskData(task);
  }
  await cleanupCategories();
}
