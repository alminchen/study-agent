/**
 * 重排验收：向量多召回 → 交叉编码器重排 → 对比前后顺序。
 *
 * 用法：先 npm run predawn:rerank 与 npm run rag:ingest，再 npm run rag:test-rerank
 */
import { DEFAULT_TOP_K, retrieveForAnswer } from "../server/rag/retrieve.js";
import { rerankerReady } from "../server/rag/rerank.js";

if (!rerankerReady()) {
  console.error("重排模型未下载，请先运行 npm run predawn:rerank");
  process.exit(1);
}

const question = "为什么改了切分还要重新入库";
const result = await retrieveForAnswer(question, DEFAULT_TOP_K);

console.log(`query: ${question}`);
console.log(`empty=${result.empty} candidates=${result.rawHits.length} injected=${result.hits.length}`);

if (result.empty) {
  console.log("FAIL: 近义问法被判空，无法演示重排");
  process.exit(1);
}

console.log("\n向量前 5：");
for (const [index, hit] of result.rawHits.slice(0, 5).entries()) {
  console.log(`  ${index + 1}. ${hit.chunk.id}  ${hit.chunk.title}`);
}

console.log("\n重排后注入：");
for (const [index, hit] of result.hits.entries()) {
  console.log(`  [${index + 1}] ${hit.chunk.id}  ${hit.chunk.title}  rerank=${hit.rerankScore?.toFixed(4)}`);
}

if (result.hits.length !== DEFAULT_TOP_K) {
  console.log(`FAIL: 注入条数应为 ${DEFAULT_TOP_K}`);
  process.exit(1);
}

const before = result.rawHits.slice(0, 5).map((hit) => hit.chunk.id).join(",");
const after = result.hits.map((hit) => hit.chunk.id).join(",");
if (before === after) {
  console.log("\nNOTE: 这条问句重排后前 5 名与向量相同（库小、问句很贴时可能发生）");
} else {
  console.log("\nPASS: 重排改变了前 5 名顺序");
}

console.log("OK 重排跑通");
