/**
 * 步骤 3 自测：后台任务循环「取活 -> 切片 -> 状态推进 / 失败分层」。
 *
 * 覆盖验收标准：
 *   1. 上传后不手动处理，worker 一轮后任务自动走到 chunked（块已落盘可预览）
 *   2. 块数记录在任务上（不是只有「成功」两个字）
 *   3. 原件缺失 -> failed(read)
 *   4. 空文/没切出块 -> failed(chunk)
 *
 * 用法：npx tsx scripts/test-kb-worker.ts
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { listChunksByDoc, removeChunksByDoc } from "../server/kb/chunkStore.js";
import { getTask, listTasks } from "../server/kb/taskStore.js";
import { uploadOriginal, UPLOAD_DIR } from "../server/kb/uploader.js";
import { runWorkerOnce } from "../server/kb/worker.js";
import type { KbTask } from "../server/kb/types.js";

const KB_DIR = path.join(process.cwd(), "data", "kb");
/** 本测试创建的任务，收尾时连同块与原件一起清掉。 */
const createdTasks: KbTask[] = [];

const GOOD_MD = `# 上传链路测试

这是用于验证后台任务循环的样本内容。

## 第二段

切片完成后应当能看到这些块。`;

async function cleanupTask(id: string): Promise<void> {
  const raw = JSON.parse(await readFile(path.join(KB_DIR, "tasks.json"), "utf-8")) as KbTask[];
  await writeFile(
    path.join(KB_DIR, "tasks.json"),
    JSON.stringify(raw.filter((task) => task.id !== id), null, 2),
    "utf-8",
  );
}

/** 清掉测试数据：任务记录 + 块 + 落盘原件。 */
async function cleanupTaskData(task: KbTask): Promise<void> {
  await cleanupTask(task.id);
  await removeChunksByDoc(task.docId);
  await rm(path.join(UPLOAD_DIR, task.docId), { recursive: true, force: true });
}

/** 先完成一次上传，再删掉原件，验证失败落在 read 层。 */
async function failOnMissingOriginal(): Promise<void> {
  const task = await uploadOriginal({
    filename: "missing.md",
    category: "面试笔记",
    content: Buffer.from(GOOD_MD).toString("base64"),
  });
  await rm(path.join(UPLOAD_DIR, task.docId), { recursive: true, force: true });
  createdTasks.push(task);
  await runWorkerOnce();
  const after = (await getTask(task.id))!;
  if (after.status !== "failed" || after.stage !== "read") {
    throw new Error(`缺原件应 failed(read)，实际 ${after.status}/${after.stage}`);
  }
  if (!after.error?.includes("读取原件失败")) {
    throw new Error(`错误信息应可读，实际 ${after.error}`);
  }
  console.log("  ok 缺失原件 -> failed(read)");
}

/** 空文件（base64 能过上传但切不出块）应失败在 chunk 层。 */
async function failOnEmpty(): Promise<void> {
  const task = await uploadOriginal({
    filename: "empty.md",
    category: "面试笔记",
    content: Buffer.from("   \n\n  ").toString("base64"),
  });
  createdTasks.push(task);
  await runWorkerOnce();
  const after = (await getTask(task.id))!;
  if (after.status !== "failed" || after.stage !== "chunk") {
    throw new Error(`空文应 failed(chunk)，实际 ${after.status}/${after.stage}`);
  }
  console.log("  ok 空文 -> failed(chunk)");
}

async function main(): Promise<void> {
  // 预置：确保任务表干净，避免旧数据干扰（不影响已有任务的合法状态）。
  console.log("1. 上传一篇 md，worker 一轮后自动到 chunked");
  const uploaded = await uploadOriginal({
    filename: "notes.md",
    category: "面试笔记",
    content: Buffer.from(GOOD_MD).toString("base64"),
  });
  createdTasks.push(uploaded);
  if (uploaded.status !== "queued") throw new Error(`上传后应为 queued，实际 ${uploaded.status}`);

  await runWorkerOnce();
  const after = (await getTask(uploaded.id))!;
  if (after.status !== "chunked") {
    throw new Error(`一轮后应为 chunked，实际 ${after.status}（${after.error ?? ""}）`);
  }
  if (!after.chunkCount || after.chunkCount < 2) {
    throw new Error(`应为 chunked 且记录块数，实际 chunkCount=${after.chunkCount}`);
  }
  const chunks = await listChunksByDoc(uploaded.docId);
  if (chunks.length !== after.chunkCount) {
    throw new Error(`块表数量 ${chunks.length} 与任务记录的 ${after.chunkCount} 不一致`);
  }
  if (chunks.some((chunk) => chunk.category !== "面试笔记" || chunk.docId !== uploaded.docId)) {
    throw new Error("块应带齐 docId/category 归属字段");
  }
  console.log(`  ok 任务 ${after.id} -> chunked（${after.chunkCount} 块）`);

  console.log("2. 失败分层：缺原件 / 空文");
  await failOnMissingOriginal();
  await failOnEmpty();

  console.log("3. 任务列表能反映最终状态");
  const listed = await listTasks();
  for (const created of createdTasks) {
    if (!listed.some((task) => task.id === created.id)) {
      throw new Error(`任务 ${created.id} 应存在于列表中`);
    }
  }

  console.log("步骤 3 自测全部通过 ✓");
}

try {
  await main();
} finally {
  for (const task of createdTasks) {
    await cleanupTaskData(task);
  }
}
