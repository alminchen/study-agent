/**
 * 单元 7：只看 HyDE 假文档（不检索）。
 *
 * 用法：
 *   npm run rag:hyde -- "chunk 怎么切"
 *   RAG_HYDE=1 npm run rag:hyde -- "chunk 怎么切"   # 与开关无关，本脚本直接调 generate
 */
import dotenv from "dotenv";
import { generateHydeDoc } from "../server/rag/queryEnhance/hyde.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法: npm run rag:hyde -- "你的问题"');
  process.exit(1);
}

try {
  const doc = await generateHydeDoc(question);
  console.log(`query: ${question}`);
  console.log(`hydeChars: ${doc.length}`);
  console.log("---");
  console.log(doc);
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`hyde failed: ${msg}`);
  process.exit(1);
}
