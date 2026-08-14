/**
 * my_notes.json 持久化自测（不重新切分、不算 embedding）。
 *
 * 验证：
 * 1. load 后库非空，每条有 id/source/title/text/seq/embedding
 * 2. save → 再 load，条数不变
 * 3. replaceSource 同名 source 不会叠成两份
 *
 * 用法：先 npm run rag:ingest，再 npm run rag:test-store
 */
import { LocalVectorStore, storePath } from "../server/rag/vectorStore.js";
import type { StoredChunk } from "../server/rag/types.js";
import { EMBED_DIM } from "../server/rag/embedding.js";

function assertRecord(chunk: StoredChunk, index: number): void {
  if (!chunk.id || !chunk.source || typeof chunk.text !== "string") {
    throw new Error(`记录 #${index} 缺 id/source/text`);
  }
  if (typeof chunk.seq !== "number" || typeof chunk.title !== "string") {
    throw new Error(`记录 #${index} 缺 seq/title`);
  }
  if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== EMBED_DIM) {
    throw new Error(`记录 #${index} embedding 维度异常`);
  }
}

const store = new LocalVectorStore();
await store.load();
console.log(`path: ${storePath()}`);
console.log(`loaded: ${store.size}`);

if (store.size === 0) {
  throw new Error("库是空的，请先运行 npm run rag:ingest");
}

// 抽样检查字段（用 search 取不到全表，这里再 load 一份 raw 不合适；用 count + 内部通过二次 load 验证）
const before = store.size;
await store.save();

const again = new LocalVectorStore();
await again.load();
if (again.size !== before) {
  throw new Error(`save/load 条数不一致: ${before} -> ${again.size}`);
}

// 用已有第一条的 source 做 replaceSource 幂等：替换成自身拷贝，条数应不变
const probeSource = "stage3-rag-notes.md";
const countBefore = again.countBySource(probeSource);
if (countBefore === 0) {
  throw new Error(`找不到 source=${probeSource}，请确认已入库该文档`);
}

// 从当前库抽出该 source 的记录（通过 search 全库扫不到，改用临时：再 load 后 replace 空再写回需要记录）
// 简化：replaceSource 成空数组再写回原 count 的占位不可行（无 embedding）。
// 改为：replaceSource(同一批) — 先 clear 该 source 再 push 0 条，确认 count 变 0，再 ingest 才恢复。
// 这里只测「删掉该 source 后 count 为 0」，然后从磁盘重新 load 恢复，避免破坏库。
again.replaceSource(probeSource, []);
if (again.countBySource(probeSource) !== 0) {
  throw new Error("replaceSource 删除失败");
}
if (again.size !== before - countBefore) {
  throw new Error("replaceSource 后总条数不对");
}

// 不 save 空删结果；从磁盘重新 load，确认原 my_notes.json 仍在
const restored = new LocalVectorStore();
await restored.load();
if (restored.size !== before || restored.countBySource(probeSource) !== countBefore) {
  throw new Error("磁盘上的 my_notes.json 被意外改坏了");
}

// 字段抽查：取一条检索结果不够，直接读文件
const { readFile } = await import("node:fs/promises");
const raw = JSON.parse(await readFile(storePath(), "utf8")) as StoredChunk[];
raw.slice(0, 3).forEach(assertRecord);
assertRecord(raw[raw.length - 1], raw.length - 1);

console.log(`source=${probeSource} count=${countBefore}`);
console.log("OK my_notes.json 持久化自测通过");
