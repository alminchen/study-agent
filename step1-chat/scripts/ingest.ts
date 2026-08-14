/**
 * 切片入库 + 入库自测。
 *
 * 流程：
 * 1. 读 Markdown → chunkMarkdown（切片）
 * 2. 逐批 embed → 组成 StoredChunk（向量 + 原文 + 来源）
 * 3. load my_notes.json → replaceSource → save（落盘）
 * 4. 原句命中 / 资料外低分 两条自测
 *
 * 用法：npx tsx scripts/ingest.ts [markdown路径]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chunkMarkdown } from "../server/rag/chunker.js";
import { embed } from "../server/rag/embedding.js";
import { MIN_TOP_SCORE } from "../server/rag/retrieve.js";
import { LocalVectorStore, storePath } from "../server/rag/vectorStore.js";
import type { StoredChunk } from "../server/rag/types.js";

const filePath = path.resolve(process.argv[2] ?? "docs-sample/stage3-rag-notes.md");
const source = path.basename(filePath);
const BATCH = 8;

const markdown = await readFile(filePath, "utf8");
const chunks = chunkMarkdown(markdown, source);
console.log(`source=${source} chunks=${chunks.length}`);
console.log("embedding ...");

const stored: StoredChunk[] = [];
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const vectors = await embed(batch.map((chunk) => chunk.text));
  for (let j = 0; j < batch.length; j++) {
    stored.push({ ...batch[j], embedding: vectors[j] });
  }
  console.log(`  ${Math.min(i + BATCH, chunks.length)} / ${chunks.length}`);
}

const store = new LocalVectorStore();
await store.load();
store.replaceSource(source, stored);
await store.save();
console.log(`saved ${store.countBySource(source)} records -> ${storePath()}`);

const original = "只入向量：检索成功也拼不出回答。";
const unrelated = "今天北京适合出门吗？";
const UNRELATED_MAX = MIN_TOP_SCORE;

const [originalVec, unrelatedVec] = await embed([original, unrelated]);
const originalHits = store.search(originalVec, 3);
const unrelatedHits = store.search(unrelatedVec, 3);

console.log("\n=== 入库自测 1：文档原句 ===");
console.log(`query: ${original}`);
for (const hit of originalHits) {
  const preview = hit.chunk.text.replace(/\s+/g, " ").slice(0, 60);
  console.log(`  ${hit.score.toFixed(4)}  ${hit.chunk.id}  ${preview}…`);
}

const topOriginal = originalHits[0];
if (!topOriginal || !topOriginal.chunk.text.includes(original)) {
  throw new Error("原句未命中对应块：入库不正确");
}

console.log("\n=== 入库自测 2：资料外问题 ===");
console.log(`query: ${unrelated}`);
for (const hit of unrelatedHits) {
  const preview = hit.chunk.text.replace(/\s+/g, " ").slice(0, 60);
  console.log(`  ${hit.score.toFixed(4)}  ${hit.chunk.id}  ${preview}…`);
}

const topUnrelated = unrelatedHits[0];
if (topUnrelated && topUnrelated.score >= UNRELATED_MAX) {
  throw new Error(`资料外问题 Top1 分数虚高: ${topUnrelated.score.toFixed(4)} >= ${UNRELATED_MAX}`);
}

console.log("\nOK 入库自测通过");
