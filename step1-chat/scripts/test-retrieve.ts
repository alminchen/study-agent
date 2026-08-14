/**
 * 检索召回验收（第三部分）。不问聊天模型。
 *
 * 1. 直接命中：贴原文的问法，目标块须进 Top5
 * 2. 近义问法：不照抄，相关块须进 Top5
 * 3. 资料外：Top1 分数不得虚高
 *
 * 用法：先 npm run rag:ingest，再 npm run rag:test-retrieve
 */
import { DEFAULT_TOP_K, MIN_TOP_SCORE, retrieve } from "../server/rag/retrieve.js";
import type { SearchHit } from "../server/rag/types.js";

const UNRELATED_MAX = MIN_TOP_SCORE;

function printHits(hits: SearchHit[]): void {
  for (const [index, hit] of hits.entries()) {
    const preview = hit.chunk.text.replace(/\s+/g, " ").slice(0, 70);
    console.log(`  ${index + 1}. ${hit.score.toFixed(4)}  ${hit.chunk.id}  ${preview}…`);
  }
}

function rankOf(hits: SearchHit[], id: string): number {
  return hits.findIndex((hit) => hit.chunk.id === id) + 1;
}

let failed = 0;

console.log(`topK=${DEFAULT_TOP_K}\n`);

console.log("=== 1. 直接命中 ===");
const q1 = "不要把整篇文档塞进 prompt 冒充 RAG";
const hits1 = await retrieve(q1);
console.log(`query: ${q1}`);
printHits(hits1);
const r28 = rankOf(hits1, "stage3-rag-notes-chunk-28");
if (r28 === 0) {
  console.log("FAIL: chunk-28 未进 Top5");
  failed += 1;
} else {
  console.log(`PASS: chunk-28 第 ${r28} 名`);
}

console.log("\n=== 2. 近义问法 ===");
const q2 = "为什么改了切分还要重新入库";
const hits2 = await retrieve(q2);
console.log(`query: ${q2}`);
printHits(hits2);
const r16 = rankOf(hits2, "stage3-rag-notes-chunk-16");
const r20 = rankOf(hits2, "stage3-rag-notes-chunk-20");
if (r16 === 0 && r20 === 0) {
  console.log("FAIL: chunk-16 / chunk-20 都未进 Top5");
  failed += 1;
} else {
  const parts = [
    r16 ? `chunk-16 第 ${r16}` : null,
    r20 ? `chunk-20 第 ${r20}` : null,
  ].filter(Boolean);
  console.log(`PASS: ${parts.join("，")}`);
}

console.log("\n=== 3. 资料外问题 ===");
const q3 = "今天北京适合出门吗？";
const hits3 = await retrieve(q3);
console.log(`query: ${q3}`);
printHits(hits3);
const top3 = hits3[0];
if (!top3) {
  console.log("FAIL: 没有返回结果");
  failed += 1;
} else if (top3.score >= UNRELATED_MAX) {
  console.log(`FAIL: Top1 分数虚高 ${top3.score.toFixed(4)} >= ${UNRELATED_MAX}`);
  failed += 1;
} else {
  console.log(`PASS: Top1 ${top3.score.toFixed(4)} < ${UNRELATED_MAX}`);
}

if (failed > 0) {
  console.log(`\n检索验收未通过（${failed} 条失败）`);
  process.exit(1);
}
console.log("\nOK 检索召回验收通过");
