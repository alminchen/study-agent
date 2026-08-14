/**
 * 拼 prompt 单元验收（不依赖向量库 / 模型）。
 *
 * 用法：npm run rag:test-prompt
 */
import { buildRagPrompt, formatEvidenceBlocks, RAG_SYSTEM_PROMPT } from "../server/rag/prompt.js";
import type { RetrievalJudgment, SearchHit, StoredChunk } from "../server/rag/types.js";

function fakeHit(partial: Partial<StoredChunk> & Pick<StoredChunk, "id" | "text">, score: number): SearchHit {
  return {
    score,
    chunk: {
      source: partial.source ?? "demo.md",
      title: partial.title ?? "演示标题",
      seq: partial.seq ?? 0,
      embedding: [],
      ...partial,
    },
  };
}

let failed = 0;

console.log("=== 1. 空结果不拼 messages ===");
const emptyJudgment: RetrievalJudgment = {
  empty: true,
  hits: [],
  rawHits: [fakeHit({ id: "noise", text: "噪声" }, 0.2)],
  rankedAll: [],
  topScore: 0.2,
  message: "资料里没有相关内容",
};
const emptyPrompt = buildRagPrompt({
  question: "今天北京适合出门吗？",
  judgment: emptyJudgment,
});
if (!emptyPrompt.empty || emptyPrompt.messages.length !== 0) {
  console.log("FAIL: 空结果应 empty=true 且 messages 为空");
  failed += 1;
} else {
  console.log(`PASS: ${emptyPrompt.message}`);
}

console.log("\n=== 2. 有命中：system 含规则+资料，user 只有问句 ===");
const hits = [
  fakeHit({ id: "a-chunk-1", text: "不要把整篇文档塞进 prompt。", title: "注意" }, 0.72),
  fakeHit({ id: "a-chunk-2", text: "改切分要重建库。", title: "入库" }, 0.65),
];
const okJudgment: RetrievalJudgment = {
  empty: false,
  hits,
  rawHits: hits,
  rankedAll: hits,
  topScore: 0.72,
};
const history = [
  { role: "user" as const, content: "上一问" },
  { role: "assistant" as const, content: "上一答" },
  { role: "user" as const, content: "更早的问" },
  { role: "assistant" as const, content: "更早的答" },
  { role: "user" as const, content: "中间问" },
  { role: "assistant" as const, content: "中间答" },
  { role: "user" as const, content: "近问" },
  { role: "assistant" as const, content: "近答" },
];
const question = "不要把整篇文档塞进 prompt 冒充 RAG";
const okPrompt = buildRagPrompt({
  question,
  judgment: okJudgment,
  history,
  maxHistoryMessages: 4,
});

if (okPrompt.empty) {
  console.log("FAIL: 有命中不应判空");
  failed += 1;
} else {
  const { messages } = okPrompt;
  const system = messages[0];
  const last = messages[messages.length - 1];
  const evidence = formatEvidenceBlocks(hits);
  let ok = true;

  if (system?.role !== "system" || !system.content.includes(RAG_SYSTEM_PROMPT)) {
    console.log("FAIL: 缺少固定 system 规则");
    ok = false;
  }
  if (!system?.content.includes("## 资料") || !system.content.includes(evidence)) {
    console.log("FAIL: system 未注入编号资料块");
    ok = false;
  }
  if (last?.role !== "user" || last.content !== question) {
    console.log("FAIL: 最后一条应为当前用户问句");
    ok = false;
  }
  if (last?.content.includes("不要把整篇文档塞进 prompt。")) {
    console.log("FAIL: 资料不应混进 user 消息");
    ok = false;
  }
  // system + 4 history + user = 6
  if (messages.length !== 6) {
    console.log(`FAIL: 历史应裁到 4 条，实际 messages=${messages.length}`);
    ok = false;
  } else if (messages[1]?.content !== "中间问" || messages[4]?.content !== "近答") {
    console.log("FAIL: 应保留最近 4 条历史");
    ok = false;
  }

  if (ok) {
    console.log(`PASS: messages=${messages.length}，资料在 system，问句在 user`);
  } else {
    failed += 1;
  }
}

if (failed > 0) {
  console.log(`\n拼 prompt 验收未通过（${failed} 条失败）`);
  process.exit(1);
}
console.log("\nOK 拼 prompt 验收通过");
