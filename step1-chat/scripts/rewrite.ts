/**
 * 只跑意图 / 扩写，不检索。用于单元 3～4 验收。
 *
 * ## 两种模式
 * 1. 默认：直接 rewriteQuery（不管 RAG_QUERY_REWRITE）
 *    → 专门看 LLM JSON 稳不稳
 * 2. --resolve：走 resolveQueryForRetrieve
 *    → 看开关 disabled / ok / fallback 全路径
 *
 * 用法：
 *   npm run rag:rewrite -- "chunk 怎么切"
 *   npm run rag:rewrite -- --resolve "chunk 怎么切"
 *   RAG_QUERY_REWRITE=1 npm run rag:rewrite -- --resolve "你好"
 */
import dotenv from "dotenv";
import {
  parseIntent,
  resolveQueryForRetrieve,
  rewriteQuery,
} from "../server/rag/queryEnhance/index.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const argv = process.argv.slice(2);
const useResolve = argv.includes("--resolve");
const question = argv.filter((a) => a !== "--resolve").join(" ").trim();

if (!question) {
  console.error('用法: npm run rag:rewrite -- "你的问题"');
  console.error('      npm run rag:rewrite -- --resolve "你的问题"  # 走开关+回退');
  process.exit(1);
}

// 先打印规则层，方便和 LLM 结果对照（单元 2 vs 3）
const ruled = parseIntent(question);
console.log("ruleIntent:", ruled ?? "(null → 开放域，规则无把握)");

if (useResolve) {
  // 单元 4：尊重 RAG_QUERY_REWRITE；失败不抛，看 meta.status
  const { query, meta } = await resolveQueryForRetrieve(question);
  console.log("resolveMeta:", JSON.stringify(meta, null, 2));
  console.log("queryForEmbed:", query);
  process.exit(0);
}

// 单元 3：直调扩写；失败 exit 1，故意不吞错
try {
  const result = await rewriteQuery(question);
  console.log("rewriteResult:", JSON.stringify(result, null, 2));
} catch (error) {
  console.error("rewrite failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
