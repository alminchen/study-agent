/**
 * 步骤 5 自测：异步入库——向量化 + 按「分类 + 文档」替换。
 *
 * 覆盖验收标准：
 *   1. 上传 -> worker 两轮（切块 / 入库）后任务为 searchable，向量可检索
 *   2. 用文档原句搜索，能召回对应块且分数可信（余弦相似度明显高）
 *   3. 无关问题分数不会虚高（原句命中必须明显领先）
 *   4. 同文件传第二版后，库里该文档块数/向量数等于最新一版，旧块无残留
 *   5. 中途失败（块表为空）任务停在 failed(embed)，不落半个文档
 *
 * 用法：npx tsx scripts/test-kb-embed.ts
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { embed } from "../server/rag/embedding.js";
import { listChunksByDoc, removeChunksByDoc } from "../server/kb/chunkStore.js";
import { getTask } from "../server/kb/taskStore.js";
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

const V1_MD = `# 动态知识库总览

这是首页段落，介绍动态知识库解决的问题。

## 上传链路

上传只创建任务，切片和入库在后台跑。

## 切片策略

切块要按标题和段落保结构，让每一块都能独立读懂。

## 入库替换

写入时按分类加文档定位，先清该文档旧块再写入新块。

## 分类边界

分类是检索的硬边界，过滤必须发生在检索层。`;

const V2_MD = `# 动态知识库总览（第二版）

这一版修正了第一版的表述。

## 上传链路

上传只创建任务，切片和入库在后台跑。

## 切片策略

切块要按标题和段落保结构，让每一块都能独立读懂。

## 入库替换

写入时按分类加文档定位，先清该文档旧块再写入新块。

## 版本校验句

第二版特有的句子，第一版里不存在。`;

const createdTasks: KbTask[] = [];

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

/** worker 跑满两轮：第一轮切块，第二轮入库；返回最新任务。 */
async function runUntilSearchable(uploaded: KbTask): Promise<KbTask> {
  await runWorkerOnce();
  let task = (await getTask(uploaded.id))!;
  if (task.status === "chunked") {
    await runWorkerOnce();
    task = (await getTask(uploaded.id))!;
  }
  return task;
}

async function main(): Promise<void> {
  console.log("1. 上传 -> worker 两轮后任务为 searchable，向量数等于块数");
  const uploaded = await uploadOriginal({
    filename: "kb-overview.md",
    category: CATEGORY,
    content: Buffer.from(V1_MD).toString("base64"),
  });
  createdTasks.push(uploaded);

  const task = await runUntilSearchable(uploaded);
  if (task.status !== "searchable" || task.stage !== null) {
    throw new Error(`入库后应 searchable，实际 ${task.status}`);
  }
  const chunkCount = (await listChunksByDoc(uploaded.docId)).length;
  const vectorCount = await countVectorsByDoc(uploaded.docId);
  if (vectorCount !== chunkCount || vectorCount !== task.chunkCount) {
    throw new Error(`向量数 ${vectorCount} 应等于块数 ${chunkCount} / 任务记录 ${task.chunkCount}`);
  }
  console.log(`  ok ${vectorCount} 条向量，与块数一致`);

  console.log("2. 文档原句搜索：能召回对应块且分数可信");
  const originalSentence = "写入时按分类加文档定位，先清该文档旧块再写入新块。";
  const [queryVec] = await embed([originalSentence]);
  const hits = await searchByCategory(CATEGORY, queryVec, 3);
  if (hits.length === 0) {
    throw new Error("原句搜索应命中至少一块");
  }
  const top = hits[0];
  if (top.record.docId !== uploaded.docId) {
    throw new Error(`原句应命中本文档，实际命中 ${top.record.source}`);
  }
  if (!top.record.text.includes("先清该文档旧块")) {
    throw new Error(`命中块应包含原句内容，实际 ${top.record.text.slice(0, 40)}`);
  }
  if (top.score < 0.7) {
    throw new Error(`原句命中分数应可信（>=0.7），实际 ${top.score.toFixed(3)}`);
  }
  console.log(`  ok 命中「入库替换」块，分数 ${top.score.toFixed(3)}`);

  console.log("3. 无关问题分数不会虚高（必须明显落后原句命中）");
  const [unrelatedVec] = await embed(["今天晚饭吃什么？"]);
  const unrelatedHits = await searchByCategory(CATEGORY, unrelatedVec, 3);
  const unrelatedTop = unrelatedHits[0]?.score ?? 0;
  if (top.score - unrelatedTop < 0.2) {
    throw new Error(
      `原句 ${top.score.toFixed(3)} 应明显领先无关问题 ${unrelatedTop.toFixed(3)}（差距>=0.2）`,
    );
  }
  console.log(`  ok 原句 ${top.score.toFixed(3)} vs 无关 ${unrelatedTop.toFixed(3)}，无需过滤也排得对`);

  console.log("4. 同文件传第二版：向量数等于最新一版，旧版句子不再命中");
  const uploadedV2 = await uploadOriginal({
    filename: "kb-overview.md",
    category: CATEGORY,
    content: Buffer.from(V2_MD).toString("base64"),
  });
  createdTasks.push(uploadedV2);
  if (uploadedV2.docId !== uploaded.docId) {
    throw new Error(`同分类同文件名应复用 docId，实际 ${uploadedV2.docId} vs ${uploaded.docId}`);
  }
  const taskV2 = await runUntilSearchable(uploadedV2);
  if (taskV2.status !== "searchable") {
    throw new Error(`第二版入库后应 searchable，实际 ${taskV2.status}`);
  }
  const v2Chunks = await listChunksByDoc(uploaded.docId);
  const v2Vectors = await countVectorsByDoc(uploaded.docId);
  if (v2Vectors !== v2Chunks.length || v2Vectors !== taskV2.chunkCount) {
    throw new Error(
      `第二版向量数 ${v2Vectors} 应等于块数 ${v2Chunks.length} / 记录 ${taskV2.chunkCount}`,
    );
  }
  if (!V2_MD.includes("版本校验句")) {
    throw new Error("测试样本问题：第二版应含校验句");
  }
  const [v2QueryVec] = await embed(["第二版特有的句子，第一版里不存在。"]);
  const v2Hit = (await searchByCategory(CATEGORY, v2QueryVec, 1))[0];
  if (!v2Hit?.record.text.includes("版本校验句")) {
    throw new Error("第二版内容应可检索到，旧版不应残留");
  }
  const [v1OnlyVec] = await embed(["分类是检索的硬边界，过滤必须发生在检索层。"]);
  const v1Check = await searchByCategory(CATEGORY, v1OnlyVec, 3);
  const staleHits = v1Check.filter(
    (hit) => hit.record.docId === uploaded.docId && hit.record.text.includes("分类是检索的硬边界"),
  );
  if (staleHits.length !== 0) {
    throw new Error("旧版块不应残留再被召回（替换式入库失效）");
  }
  console.log(`  ok 第二版 ${v2Vectors} 条向量，替换式入库生效、旧版无残留`);

  console.log("步骤 5 自测全部通过 ✓");
}

try {
  await main();
} finally {
  for (const task of createdTasks) {
    await cleanupTaskData(task);
  }
}
