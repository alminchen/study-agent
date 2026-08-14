/**
 * 空结果判断验收。
 *
 * 1. 有资料的问题 → empty=false，hits 非空
 * 2. 资料外问题 → empty=true，hits 为空，仍保留 rawHits 供调试
 *
 * 用法：npm run rag:test-empty
 */
import { MIN_TOP_SCORE, retrieveForAnswer } from "../server/rag/retrieve.js";

let failed = 0;

console.log(`minTopScore=${MIN_TOP_SCORE}\n`);

console.log("=== 1. 有资料 ===");
const q1 = "不要把整篇文档塞进 prompt 冒充 RAG";
const r1 = await retrieveForAnswer(q1);
console.log(`query: ${q1}`);
console.log(`empty=${r1.empty} topScore=${r1.topScore?.toFixed(4)} hits=${r1.hits.length}`);
if (r1.empty || r1.hits.length === 0) {
  console.log("FAIL: 有资料的问题被判空");
  failed += 1;
} else {
  console.log(`PASS: 可注入，Top1=${r1.hits[0].chunk.id}`);
}

console.log("\n=== 2. 资料外 ===");
const q2 = "今天北京适合出门吗？";
const r2 = await retrieveForAnswer(q2);
console.log(`query: ${q2}`);
console.log(`empty=${r2.empty} topScore=${r2.topScore?.toFixed(4)} hits=${r2.hits.length} rawHits=${r2.rawHits.length}`);
console.log(`message: ${r2.message ?? "(none)"}`);
if (!r2.empty) {
  console.log("FAIL: 资料外问题未判空");
  failed += 1;
} else if (r2.hits.length !== 0) {
  console.log("FAIL: 判空后 hits 应为空，避免注入噪声");
  failed += 1;
} else if (r2.rawHits.length === 0) {
  console.log("FAIL: rawHits 应保留原始 TopK 供调试");
  failed += 1;
} else if ((r2.topScore ?? 1) >= MIN_TOP_SCORE) {
  console.log("FAIL: topScore 不应达到门槛");
  failed += 1;
} else {
  console.log("PASS: 判空，hits 已清空，rawHits 仍可查看");
}

if (failed > 0) {
  console.log(`\n空结果判断未通过（${failed} 条失败）`);
  process.exit(1);
}
console.log("\nOK 空结果判断验收通过");
