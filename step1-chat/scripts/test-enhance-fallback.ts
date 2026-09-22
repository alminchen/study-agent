/**
 * 单元 9：增强层故障注入 ≥3 种，验收回退 + status 标记。
 *
 * 用法：npm run rag:test-enhance-fallback
 *
 * 注入项：
 * 1) 扩写：REWRITE=1 + MOCK_MODE=1 → rewrite status=fallback，检索仍继续
 * 2) HyDE：HYDE=1 + MOCK_MODE=1 → hyde status=fallback，仍用 queryUsed 检索
 * 3) 路由 none：KB_ROUTE=1 + FORCE=none → 跳过 search，message 可区分
 * 4) Multi&lt;2：MULTI=1 + 极短问句拼不出两路 → multi status=skipped，退回单路
 *
 * 任一项若抛未捕获异常 → process.exit(1)
 */
import dotenv from "dotenv";
import { resolveQueryForRetrieve } from "../server/rag/queryEnhance/index.js";
import { resolveHydeQuery } from "../server/rag/queryEnhance/hyde.js";
import { retrieveForAnswer } from "../server/rag/retrieve.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

type CaseResult = { name: string; ok: boolean; detail: string };

function resetEnhanceEnv(): void {
  process.env.RAG_QUERY_REWRITE = "0";
  process.env.RAG_KB_ROUTE = "0";
  delete process.env.RAG_KB_ROUTE_FORCE;
  process.env.RAG_MULTI_QUERY = "0";
  process.env.RAG_HYDE = "0";
  process.env.MOCK_MODE = "0";
}

const cases: CaseResult[] = [];

function pass(name: string, detail: string): void {
  cases.push({ name, ok: true, detail });
  console.log(`PASS  ${name}: ${detail}`);
}

function fail(name: string, detail: string): void {
  cases.push({ name, ok: false, detail });
  console.error(`FAIL  ${name}: ${detail}`);
}

// ---- 1) 扩写失败回退 ----
{
  const name = "rewrite fallback (MOCK)";
  try {
    resetEnhanceEnv();
    process.env.RAG_QUERY_REWRITE = "1";
    process.env.MOCK_MODE = "1";
    const { query, meta } = await resolveQueryForRetrieve("chunk 怎么切");
    if (meta.status === "fallback" && query === "chunk 怎么切" && meta.reason) {
      pass(name, `status=${meta.status} reason=${meta.reason.slice(0, 60)}`);
    } else {
      fail(name, `unexpected meta=${JSON.stringify(meta)}`);
    }
  } catch (error) {
    fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- 2) HyDE 失败回退 ----
{
  const name = "hyde fallback (MOCK)";
  try {
    resetEnhanceEnv();
    process.env.RAG_HYDE = "1";
    process.env.MOCK_MODE = "1";
    const { embedText, meta } = await resolveHydeQuery("chunk 怎么切", "chunk 怎么切");
    if (meta.status === "fallback" && embedText === "chunk 怎么切" && meta.hydeDoc === null) {
      pass(name, `status=${meta.status} embedText=queryUsed`);
    } else {
      fail(name, `unexpected meta=${JSON.stringify(meta)}`);
    }
  } catch (error) {
    fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- 3) 路由 none 跳过检索 ----
{
  const name = "kbRoute none skip search";
  try {
    resetEnhanceEnv();
    process.env.RAG_KB_ROUTE = "1";
    process.env.RAG_KB_ROUTE_FORCE = "none";
    const result = await retrieveForAnswer("chunk 怎么切");
    const msg = result.message ?? "";
    if (
      result.empty &&
      result.kbRouteMeta?.route === "none" &&
      msg.includes("none") &&
      result.rawHits.length === 0
    ) {
      pass(name, `route=none message=${msg}`);
    } else {
      fail(
        name,
        `empty=${result.empty} route=${result.kbRouteMeta?.route} msg=${msg} hits=${result.rawHits.length}`,
      );
    }
  } catch (error) {
    fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- 4) Multi 与 HyDE 同开 → 跳过多路 ----
{
  const name = "multi skipped when HyDE on";
  try {
    resetEnhanceEnv();
    process.env.RAG_MULTI_QUERY = "1";
    process.env.RAG_HYDE = "1";
    process.env.MOCK_MODE = "1"; // HyDE 失败回退，但仍走 HyDE 分支并 skip multi
    const result = await retrieveForAnswer("chunk 怎么切");
    if (result.multiQueryMeta?.status === "skipped" && result.hydeMeta?.status === "fallback") {
      pass(
        name,
        `multi=${result.multiQueryMeta.status} hyde=${result.hydeMeta.status} reason=${result.multiQueryMeta.reason ?? ""}`,
      );
    } else {
      fail(
        name,
        `multi=${result.multiQueryMeta?.status} hyde=${result.hydeMeta?.status}`,
      );
    }
  } catch (error) {
    fail(name, `threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const failed = cases.filter((c) => !c.ok);
console.log("");
console.log(`合计 ${cases.length} 项，失败 ${failed.length}`);
if (failed.length > 0) {
  process.exit(1);
}
console.log("单元 9 故障注入验收通过。回退表见 docs/rag-query-enhance-notes.md §单元 9");
