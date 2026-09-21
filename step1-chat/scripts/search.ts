/**
 * 检索预览：向量召回 → 判空 →（有资料则）重排 → 打印前后顺序。
 * 若开启 RAG_QUERY_REWRITE / RAG_KB_ROUTE / RAG_MULTI_QUERY / RAG_HYDE，会打印对应 meta。
 *
 * 用法：npx tsx scripts/search.ts "你的问题"
 */
import dotenv from "dotenv";
import {
  CANDIDATE_K,
  DEFAULT_TOP_K,
  MIN_TOP_SCORE,
  retrieveForAnswer,
} from "../server/rag/retrieve.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法: npm run rag:search -- "你的问题"');
  process.exit(1);
}

const result = await retrieveForAnswer(question, DEFAULT_TOP_K);
console.log(`query(original): ${question}`);
if (result.rewriteMeta) {
  const m = result.rewriteMeta;
  console.log(`rewrite: status=${m.status} intent=${m.intent ?? "null"}`);
  console.log(`queryUsed: ${m.queryUsed}`);
  if (m.rewritten) console.log(`rewritten: ${m.rewritten}`);
  if (m.reason) console.log(`fallbackReason: ${m.reason}`);
  if (m.keywords.length) console.log(`keywords: ${m.keywords.join(", ")}`);
}
if (result.kbRouteMeta) {
  const k = result.kbRouteMeta;
  console.log(`kbRoute: status=${k.status} route=${k.route}`);
  console.log(`sourcesAllowed: ${k.sourcesAllowed === null ? "(all)" : JSON.stringify(k.sourcesAllowed)}`);
  if (k.reason) console.log(`routeReason: ${k.reason}`);
}
if (result.multiQueryMeta) {
  const mq = result.multiQueryMeta;
  console.log(`multiQuery: status=${mq.status} merge=${mq.merge} merged=${mq.mergedCount}`);
  if (mq.reason) console.log(`multiQueryReason: ${mq.reason}`);
  for (let i = 0; i < mq.queries.length; i++) {
    const top = mq.perQueryTopIds?.[i]?.join(", ") ?? "";
    console.log(`  q${i + 1}: ${mq.queries[i]}${top ? `  topIds=[${top}]` : ""}`);
  }
}
if (result.hydeMeta) {
  const h = result.hydeMeta;
  console.log(`hyde: status=${h.status} embedChars=${h.embedText.length}`);
  if (h.reason) console.log(`hydeReason: ${h.reason}`);
  if (h.hydeDoc) {
    const preview = h.hydeDoc.replace(/\s+/g, " ").slice(0, 200);
    console.log(`hydeDoc: ${preview}${h.hydeDoc.length > 200 ? "…" : ""}`);
  }
}
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
