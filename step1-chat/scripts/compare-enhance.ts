/**
 * 单元 8：同一批黄金问句对照 single / multi / hyde（路由开着）。
 *
 * 用法：
 *   npm run rag:compare-enhance
 *   npm run rag:compare-enhance -- "chunk 怎么切" "请假要交什么材料"
 *
 * 每问三轮：临时改 env（不写盘），互斥召回增强；RAG_KB_ROUTE 固定开。
 */
import dotenv from "dotenv";
import { retrieveForAnswer } from "../server/rag/retrieve.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

type Strategy = "single" | "multi" | "hyde";

const DEFAULT_QUESTIONS = [
  "chunk 怎么切",
  "请假要交什么材料",
  "不要把整篇文档塞进 prompt 冒充 RAG",
];

function applyStrategy(strategy: Strategy): void {
  // 路由始终开（单元 8 验收要求）
  process.env.RAG_KB_ROUTE = "1";
  delete process.env.RAG_KB_ROUTE_FORCE;
  // 对照时关掉扩写，避免与 multi/hyde 叠变量
  process.env.RAG_QUERY_REWRITE = "0";
  process.env.RAG_MULTI_QUERY = strategy === "multi" ? "1" : "0";
  process.env.RAG_HYDE = strategy === "hyde" ? "1" : "0";
}

function top1(result: Awaited<ReturnType<typeof retrieveForAnswer>>): string {
  const hit = result.rawHits[0];
  if (!hit) return "(无命中)";
  const title = hit.chunk.title || hit.chunk.id;
  return `${hit.score.toFixed(4)} · ${title} · ${hit.chunk.source}`;
}

async function runOne(question: string, strategy: Strategy) {
  applyStrategy(strategy);
  const result = await retrieveForAnswer(question);
  return {
    strategy,
    empty: result.empty,
    message: result.message ?? "",
    route: result.kbRouteMeta?.route ?? "?",
    multi: result.multiQueryMeta?.status ?? "?",
    hyde: result.hydeMeta?.status ?? "?",
    top1: top1(result),
  };
}

const questions = process.argv.slice(2).filter(Boolean);
const list = questions.length > 0 ? questions : DEFAULT_QUESTIONS;

console.log("=== 单元 8 策略对照（RAG_KB_ROUTE=1，REWRITE 关）===\n");

for (const q of list) {
  console.log(`问句: ${q}`);
  for (const s of ["single", "multi", "hyde"] as Strategy[]) {
    try {
      const row = await runOne(q, s);
      console.log(
        `  [${s.padEnd(6)}] empty=${row.empty} route=${row.route} multi=${row.multi} hyde=${row.hyde}`,
      );
      console.log(`           Top1: ${row.top1}`);
      if (row.message) console.log(`           message: ${row.message}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  [${s.padEnd(6)}] ERROR: ${msg.slice(0, 120)}`);
    }
  }
  console.log("");
}

console.log("默认策略（本课书面结论）：REWRITE=1 + KB_ROUTE=1；MULTI/HYDE 按需手动开。");
console.log("详见 docs/rag-query-enhance-notes.md §单元 8");
