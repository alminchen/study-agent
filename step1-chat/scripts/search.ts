/**
 * 检索预览：向量召回 → 判空 →（有资料则）重排 → 打印前后顺序。
 *
 * 用法：npx tsx scripts/search.ts "你的问题"
 */
import {
  CANDIDATE_K,
  DEFAULT_TOP_K,
  MIN_TOP_SCORE,
  retrieveForAnswer,
} from "../server/rag/retrieve.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法: npm run rag:search -- "你的问题"');
  process.exit(1);
}

const result = await retrieveForAnswer(question, DEFAULT_TOP_K);
console.log(`query: ${question}`);
console.log(`candidateK: ${CANDIDATE_K}  injectK: ${DEFAULT_TOP_K}  minTopScore: ${MIN_TOP_SCORE}`);
console.log(`empty: ${result.empty}  vectorTop1: ${result.topScore?.toFixed(4) ?? "null"}`);
if (result.message) {
  console.log(`message: ${result.message}`);
}
console.log("---");

console.log("=== 向量召回（候选） ===");
for (const [index, hit] of result.rawHits.entries()) {
  const preview = hit.chunk.text.replace(/\s+/g, " ").slice(0, 70);
  console.log(`${index + 1}. vec=${hit.score.toFixed(4)}  ${hit.chunk.id}  title="${hit.chunk.title}"`);
  console.log(`   ${preview}…`);
}

if (result.empty) {
  console.log("\n判空：不重排、不注入");
  process.exit(0);
}

console.log("\n=== 重排后注入 ===");
for (const [index, hit] of result.hits.entries()) {
  const preview = hit.chunk.text.replace(/\s+/g, " ").slice(0, 70);
  const rerank = hit.rerankScore?.toFixed(4) ?? "n/a";
  console.log(`[${index + 1}] rerank=${rerank}  vec=${hit.score.toFixed(4)}  ${hit.chunk.id}  title="${hit.chunk.title}"`);
  console.log(`   ${preview}…`);
}
