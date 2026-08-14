/**
 * 拼 prompt 预览：检索 → 空结果判断 → 固定 system + 注入命中块。
 * 不调用聊天模型，不接 /api/chat。
 *
 * 用法：
 *   npm run rag:preview-prompt -- "不要把整篇文档塞进 prompt 冒充 RAG"
 *   npm run rag:preview-prompt -- "今天北京适合出门吗？"
 */
import {
  DEFAULT_TOP_K,
  retrieveForAnswer,
} from "../server/rag/retrieve.js";
import { buildRagPrompt } from "../server/rag/prompt.js";
import type { RagMessage } from "../server/rag/prompt.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('用法: npm run rag:preview-prompt -- "你的问题"');
  process.exit(1);
}

/** 演示：历史与资料分开；当前问题由脚本参数给出，不放进 history。 */
const demoHistory: RagMessage[] = [
  { role: "user", content: "RAG 和整篇塞进 messages 有什么区别？" },
  {
    role: "assistant",
    content: "RAG 先检索相关段落再回答；整篇塞进会超窗口且难引用。",
  },
];

const judgment = await retrieveForAnswer(question, DEFAULT_TOP_K);
const prompt = buildRagPrompt({
  question,
  judgment,
  history: demoHistory,
});

console.log(`query: ${question}`);
console.log(`empty: ${prompt.empty}  topScore: ${judgment.topScore?.toFixed(4) ?? "null"}`);
console.log("---");

if (prompt.empty) {
  console.log(`不调模型，直接返回: ${prompt.message}`);
  console.log(`messages.length = ${prompt.messages.length}`);
  process.exit(0);
}

console.log(`messages.length = ${prompt.messages.length}`);
for (const [index, message] of prompt.messages.entries()) {
  const preview =
    message.content.length > 240
      ? `${message.content.slice(0, 240)}…`
      : message.content;
  console.log(`\n[${index}] role=${message.role}  chars=${message.content.length}`);
  console.log(preview);
}
