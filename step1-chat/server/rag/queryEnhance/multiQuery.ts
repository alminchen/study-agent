/**
 * 单元 6：Multi-Query（多路检索合并）。
 *
 * ## 解决什么
 * 单路 rewritten 仍可能漏召；用 2～3 条不同角度的问句分别 embed→search，
 * 再按 chunk.id 合并，扩大召回面。
 *
 * ## 本实现的取舍
 * - 问句生成：规则拼装（queryUsed + keywords + original），不默认再调一次 LLM
 *   （对照实验变量更少；要 LLM 产 queries[] 可后置）
 * - 合并：同 id 取 max(向量分)，再按分排序截断 —— 本仓库分数同属余弦，刻度可比
 * - N 默认最多 3，禁止开到 10
 *
 * ## 开关
 * RAG_MULTI_QUERY=1 才启用；与扩写、路由独立。对照时不要与 HyDE 同开。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第六部分
 */

import { embed } from "../embedding.js";
import { LocalVectorStore } from "../vectorStore.js";
import type { SearchHit } from "../types.js";
import type { MultiQueryMeta, RewriteMeta } from "./types.js";

/** 教学默认最多 3 路；再多成本高且噪声大 */
export const MULTI_QUERY_MAX = 3;

export function isMultiQueryEnabled(): boolean {
  const raw = (process.env.RAG_MULTI_QUERY ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * 从原句 + 扩写 meta 拼 2～3 条检索句。
 *
 * 角度优先级：
 * 1. queryUsed（扩写句或原句）——主路
 * 2. keywords 空格拼接 —— 扩写产出的短词
 * 3. original（若与主路不同）
 * 4. 规则合成角：去疑问语气 / 小表术语扩展 / 「文档说明」模板
 *    （保证单独开 RAG_MULTI_QUERY、不开扩写时也能 ≥2 路）
 *
 * 去重、去空；不足 2 条时调用方应退回单路。
 */
export function buildMultiQueries(
  original: string,
  rewriteMeta?: RewriteMeta | null,
): string[] {
  const primary = (rewriteMeta?.queryUsed || original).trim();
  const orig = original.trim();
  const keywordLine = (rewriteMeta?.keywords ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");

  const candidates = [
    primary,
    keywordLine,
    orig,
    ...synthesizeAngles(orig),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of candidates) {
    const t = q.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= MULTI_QUERY_MAX) break;
  }
  return out;
}

/**
 * 无 LLM 时的多角度合成（教学用小规则，不是通用 NLU）。
 * 目的：让「只开 Multi-Query」也能走出 ≥2 路，便于对照实验。
 */
function synthesizeAngles(text: string): string[] {
  const t = text.trim();
  if (!t) return [];

  const angles: string[] = [];

  // 去疑问语气 → 更接近文档标题 / 术语表述
  const asTopic = t
    .replace(/[？?！!]+$/g, "")
    .replace(/^(请问|想问一下|帮我|请)\s*/u, "")
    .replace(/(怎么|如何|怎样)(办|做|切|用|写|配|设|配)?/gu, "")
    .replace(/(是什么|什么意思|有哪些|要交什么)/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (asTopic && asTopic.toLowerCase() !== t.toLowerCase()) {
    angles.push(asTopic);
  }

  // 小表术语扩展：命中则追加一条「主题 + 相关词」
  const expansions: Array<[RegExp, string]> = [
    [/chunk|切片|切分|overlap/i, "chunk size overlap 按意思切"],
    [/embedding|向量|embed/i, "embedding 入库 向量检索"],
    [/rerank|重排/i, "reranker 重排 TopK"],
    [/请假|年假|材料|审批/i, "请假 材料 审批 制度"],
    [/prompt|上下文|注入/i, "prompt 上下文 注入 TopK"],
  ];
  for (const [re, extra] of expansions) {
    if (re.test(t)) {
      const base = asTopic || t;
      angles.push(`${base} ${extra}`.trim());
      break;
    }
  }

  // 仍可能与原句撞车：强制一条「文档说明」模板作兜底第二路
  angles.push(`文档中关于「${asTopic || t}」的说明与注意事项`);

  return angles;
}

/**
 * 多路 hits → 按 chunk.id 合并：保留最高 score，再整体排序截断到 limit。
 * 为何用 max 而不是 RRF：本课向量分都是同一 embed 的余弦，直接比分更直观。
 */
export function mergeHitsByMaxScore(hitLists: SearchHit[][], limit: number): SearchHit[] {
  const best = new Map<string, SearchHit>();
  for (const list of hitLists) {
    for (const hit of list) {
      const id = hit.chunk.id;
      const prev = best.get(id);
      if (!prev || hit.score > prev.score) {
        best.set(id, hit);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface MultiSearchOptions {
  /** 每路召回条数（通常用 CANDIDATE_K） */
  perQueryTopK: number;
  /** 合并后截断到多少条再交给闸门 */
  mergeLimit: number;
  /** 单元 5 硬过滤 */
  sources?: string[] | null;
}

export interface MultiSearchResult {
  hits: SearchHit[];
  meta: MultiQueryMeta;
}

/**
 * 多路检索主过程：一次 load 库、批量 embed、分路 search、max 合并。
 */
export async function searchMultiQuery(
  queries: string[],
  options: MultiSearchOptions,
): Promise<MultiSearchResult> {
  const cleaned = queries.map((q) => q.trim()).filter(Boolean).slice(0, MULTI_QUERY_MAX);
  if (cleaned.length === 0) {
    return {
      hits: [],
      meta: {
        status: "ok",
        queries: [],
        merge: "max_score",
        perQueryHitCounts: [],
        mergedCount: 0,
        reason: "无有效检索句",
      },
    };
  }

  const store = new LocalVectorStore();
  await store.load();
  if (store.size === 0) {
    throw new Error("向量库是空的，请先运行 npm run rag:ingest");
  }

  // 批量 embed：比 for 循环多次 pipeline 更省
  const vectors = await embed(cleaned);
  const lists: SearchHit[][] = [];
  const perQueryHitCounts: number[] = [];
  const perQueryTopIds: string[][] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const hits = store.search(vectors[i], options.perQueryTopK, {
      sources: options.sources,
    });
    lists.push(hits);
    perQueryHitCounts.push(hits.length);
    perQueryTopIds.push(hits.slice(0, 3).map((h) => h.chunk.id));
  }

  const merged = mergeHitsByMaxScore(lists, options.mergeLimit);
  return {
    hits: merged,
    meta: {
      status: "ok",
      queries: cleaned,
      merge: "max_score",
      perQueryHitCounts,
      perQueryTopIds,
      mergedCount: merged.length,
    },
  };
}

/** 开关关闭时的占位 meta，便于 CLI 统一打印 */
export function disabledMultiQueryMeta(): MultiQueryMeta {
  return {
    status: "disabled",
    queries: [],
    merge: "max_score",
    perQueryHitCounts: [],
    mergedCount: 0,
    reason: "RAG_MULTI_QUERY 未开启",
  };
}
