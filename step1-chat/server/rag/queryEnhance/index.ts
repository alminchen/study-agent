/**
 * 单元 4：决定「用哪句话去 embed」+ 模块对外出口。
 *
 * ## 在总链路中的位置
 *   用户原句 → resolveQueryForRetrieve → queryUsed
 *            → retrieve.embed(queryUsed) → 闸门 / 重排（逻辑不改）
 *
 * ## 环境开关 RAG_QUERY_REWRITE
 * 未设或非 1/true/on/yes → status=disabled，query=原句。
 * 默认关闭，方便「关/开」对照实验，也避免无 Key 时每次检索都炸。
 *
 * ## 回退策略（教学默认）
 * rewriteQuery throw（无 Key、超时、坏 JSON…）→ 不往外抛：
 * status=fallback，仍用原句检索，reason 写入 meta。
 * 整次 RAG 不应因扩写层 500。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第四部分
 */

import { parseIntent } from "./parseIntent.js";
import { rewriteQuery, type RewriteQueryOptions } from "./rewriteQuery.js";
import type { RewriteMeta } from "./types.js";

/**
 * 是否启用检索前扩写。
 * 读 env 而不是写死 true：对照实验与生产默认行为要可关。
 */
export function isQueryRewriteEnabled(): boolean {
  const raw = (process.env.RAG_QUERY_REWRITE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface ResolveQueryResult {
  /** 交给 embed / retrieve 的问句（至少是原句） */
  query: string;
  /** 可解释元数据：CLI / SSE rag_meta / 日志 */
  meta: RewriteMeta;
}

/**
 * 解析检索用问句。
 *
 * 保证：无论开关与扩写成败，都返回可用的 query。
 * retrieveForAnswer 只应依赖本函数的返回值，不要自己再 try/catch rewriteQuery。
 */
export async function resolveQueryForRetrieve(
  original: string,
  options: RewriteQueryOptions = {},
): Promise<ResolveQueryResult> {
  const trimmed = original.trim();
  // 规则预判始终跑一遍：disabled 时也能在 meta 里看见规则结果，方便对照
  const ruleIntent = parseIntent(trimmed);

  // ---- 开关关闭：与改前行为一致 ----
  if (!isQueryRewriteEnabled()) {
    return {
      query: trimmed,
      meta: {
        original: trimmed,
        queryUsed: trimmed,
        rewritten: null,
        intent: ruleIntent?.intent ?? null,
        slots: ruleIntent?.slots ?? {},
        keywords: ruleIntent?.keywords ?? [],
        status: "disabled",
        ruleIntent,
      },
    };
  }

  // ---- 开关打开：扩写成功用 rewritten；失败回退原句 ----
  try {
    const rewritten = await rewriteQuery(trimmed, options);
    return {
      query: rewritten.rewritten,
      meta: {
        original: trimmed,
        queryUsed: rewritten.rewritten,
        rewritten: rewritten.rewritten,
        intent: rewritten.intent,
        slots: rewritten.slots,
        keywords: rewritten.keywords,
        status: "ok",
        ruleIntent,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 打 warn 不 throw：检索主路径要继续
    console.warn(`[queryEnhance] rewrite fallback: ${reason}`);
    return {
      query: trimmed,
      meta: {
        original: trimmed,
        queryUsed: trimmed,
        rewritten: null,
        intent: ruleIntent?.intent ?? null,
        slots: ruleIntent?.slots ?? {},
        keywords: ruleIntent?.keywords ?? [],
        status: "fallback",
        reason,
        ruleIntent,
      },
    };
  }
}

// ---- 再导出：调用方只需 from "./queryEnhance/index.js" ----
export { parseIntent, parseIntentOrUnknown } from "./parseIntent.js";
export { rewriteQuery, parseRewriteJson } from "./rewriteQuery.js";
export {
  resolveKbRoute,
  routeKbByRules,
  isKbRouteEnabled,
  sourcesForRoute,
  getForcedKbRoute,
} from "./kbRoute.js";
export {
  isMultiQueryEnabled,
  buildMultiQueries,
  searchMultiQuery,
  mergeHitsByMaxScore,
  disabledMultiQueryMeta,
  MULTI_QUERY_MAX,
} from "./multiQuery.js";
export {
  isHydeEnabled,
  generateHydeDoc,
  resolveHydeQuery,
  disabledHydeMeta,
  HYDE_DOC_MAX_CHARS,
} from "./hyde.js";
export type {
  IntentSlots,
  ParsedIntent,
  QueryIntent,
  RewriteMeta,
  RewriteResult,
  RewriteStatus,
  KbRoute,
  KbRouteMeta,
  KbRouteStatus,
  MultiQueryMeta,
  MultiQueryStatus,
  HydeMeta,
  HydeStatus,
} from "./types.js";
