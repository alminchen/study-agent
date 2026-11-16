/**
 * 步骤 4 自测：块预览接口 + 切片参数实验。
 *
 * 覆盖验收标准：
 *   1. 上传一篇结构清楚的 md，worker 切块后可预览完整块列表（按 seq 排序）
 *   2. 每块能单独读懂：标题带在正文前面，没有和正文拆开
 *   3. 任务日志/任务记录上有切块数量
 *   4. 参数实验：把 overlap 调成 0 再切一次，能看到同一文件块边界/数量变化
 *
 * 用法：npx tsx scripts/test-kb-chunks.ts
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "../server/rag/chunker.js";
import { listChunksByDoc, removeChunksByDoc } from "../server/kb/chunkStore.js";
import { getTask } from "../server/kb/taskStore.js";
import { uploadOriginal, UPLOAD_DIR } from "../server/kb/uploader.js";
import { runWorkerOnce } from "../server/kb/worker.js";
import type { KbTask } from "../server/kb/types.js";

const KB_DIR = path.join(process.cwd(), "data", "kb");

const LONG_MD = `# 动态知识库总览

这是首页段落，介绍动态知识库解决的问题。

## 上传链路

上传只创建任务，切片和入库在后台跑。
文件必须从浏览器进服务器，留下原件和任务记录，接口要秒回。
上传失败（超限、空文件、类型不对）必须能告诉用户，不能静默丢。

## 切片策略

切块要按标题和段落保结构，让每一块都能独立读懂。
块太大，命中块里噪声多、回答飘；块太小，语义被切碎、召回不到关键句。
切分参数对同一文件要固定，改了必须整篇重切重入。

## 入库替换

写入时按分类加文档定位，先清该文档旧块再写入新块。
同一文档再次上传，问答用的是新块，旧块不残留。

## 分类边界

分类是检索的硬边界，过滤必须发生在检索层。
问规范不该搜到日记，未选分类不允许入库。`;

const createdTasks: KbTask[] = [];

async function cleanupTaskData(task: KbTask): Promise<void> {
  const raw = JSON.parse(await readFile(path.join(KB_DIR, "tasks.json"), "utf-8")) as KbTask[];
  await writeFile(
    path.join(KB_DIR, "tasks.json"),
    JSON.stringify(raw.filter((row) => row.id !== task.id), null, 2),
    "utf-8",
  );
  await removeChunksByDoc(task.docId);
  await rm(path.join(UPLOAD_DIR, task.docId), { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("1. 上传后 worker 切块，预览返回完整块列表（按 seq）");
  const uploaded = await uploadOriginal({
    filename: "kb-overview.md",
    category: "面试笔记",
    content: Buffer.from(LONG_MD).toString("base64"),
  });
  createdTasks.push(uploaded);
  await runWorkerOnce();
  const task = (await getTask(uploaded.id))!;
  if (task.status !== "chunked" || !task.chunkCount) {
    throw new Error(`应为 chunked 且带块数，实际 ${task.status} / ${task.chunkCount}`);
  }
  const chunkTask = await getTask(uploaded.id);
  const chunks = await listChunksByDoc(uploaded.docId);
  if (chunks.length !== chunkTask!.chunkCount) {
    throw new Error(`预览块数 ${chunks.length} 与任务记录 ${chunkTask!.chunkCount} 不一致`);
  }
  const seqs = chunks.map((chunk) => chunk.seq);
  if (seqs.some((seq, i) => seq !== i)) {
    throw new Error(`块应按 seq 从 0 连续排序，实际 ${seqs.join(",")}`);
  }
  console.log(`  ok ${chunks.length} 块，seq 连续（0..${chunks.length - 1}）`);

  console.log("2. 每块能单独读懂：标题在正文前、内容非空");
  for (const chunk of chunks) {
    if (!chunk.text) throw new Error(`块 ${chunk.seq} 正文为空`);
    if (chunk.title && !chunk.text.startsWith(chunk.title)) {
      throw new Error(`块 ${chunk.seq} 的标题 ${chunk.title} 和正文拆开了`);
    }
    if (chunk.text.length < 5) throw new Error(`块 ${chunk.seq} 太碎（无法独立读懂）`);
  }
  console.log("  ok 全部块：标题未拆、内容可读");

  console.log("3. 参数实验：overlap 0 切同一篇，块边界/数量应变化");
  // 只用超长段落才会触发「二次切 + overlap」；短段落按段落分块，overlap 不生效。
  const longPara = "这是一段故意写得很长的正文。" + "重复的句子让长度超过单块上限。".repeat(30);
  const LONG_ONLY_MD = `# 实验样本\n\n${longPara}`;
  const defaultChunks = chunkMarkdown(LONG_ONLY_MD, "experiment.md");
  const noOverlapChunks = chunkMarkdown(LONG_ONLY_MD, "experiment.md", { overlapRatio: 0 });
  const defaultTexts = defaultChunks.map((chunk) => chunk.text);
  const noOverlapTexts = noOverlapChunks.map((chunk) => chunk.text);
  const defaultJoined = defaultTexts.join("|");
  const noOverlapJoined = noOverlapTexts.join("|");
  if (defaultTexts.length < 2) {
    throw new Error(`实验样本应切出多块，实际 ${defaultTexts.length}`);
  }
  if (defaultJoined === noOverlapJoined) {
    throw new Error("overlap 应为 0 与默认之下的切分结果应有差异（重叠接缝）");
  }
  console.log(`  ok 默认 overlap 切 ${defaultTexts.length} 块；overlap=0 切 ${noOverlapTexts.length} 块，接缝差异可验证`);

  console.log("步骤 4 自测全部通过 ✓");
}

try {
  await main();
} finally {
  for (const task of createdTasks) {
    await cleanupTaskData(task);
  }
}
