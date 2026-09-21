/**
 * RAG 问答：检索 → 拼 prompt → 调 LLM。
 * 不接 /api/chat，不走天气/时间工具。
 *
 * 用法：npm run rag:ask -- "不要把整篇文档塞进 prompt 冒充 RAG"
 */
import dotenv from "dotenv";
import { answerFromDocs } from "../server/rag/answer.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法: npm run rag:ask -- "你的问题"');
  process.exit(1);
}

const result = await answerFromDocs(question);

console.log(`query: ${question}`);
if (result.rewriteMeta) {
  const m = result.rewriteMeta;
  console.log(`rewrite: status=${m.status} queryUsed=${m.queryUsed}`);
}
if (result.multiQueryMeta && result.multiQueryMeta.status !== "disabled") {
  const mq = result.multiQueryMeta;
  console.log(`multiQuery: status=${mq.status} n=${mq.queries.length} merged=${mq.mergedCount}`);
}
if (result.hydeMeta && result.hydeMeta.status !== "disabled") {
  const h = result.hydeMeta;
  console.log(`hyde: status=${h.status} chars=${h.hydeDoc?.length ?? 0}`);
}
console.log(`empty: ${result.empty}  calledModel: ${result.calledModel}  topScore: ${result.topScore?.toFixed(4) ?? "null"}`);
console.log("hits:");
for (const hit of result.hits) {
  const tag = hit.promptIndex != null ? `[${hit.promptIndex}]` : "未注入";
  console.log(`  #${hit.rank} ${tag} ${hit.score.toFixed(4)}  ${hit.id}`);
}
console.log("---");
console.log(result.answer);
