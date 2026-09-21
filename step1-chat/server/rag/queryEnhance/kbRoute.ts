/**
 * 单元 5：多知识库路由（模拟分库）。
 *
 * ## 解决什么
 * 全库向量扫会把「请假材料」打进技术笔记 TopK。
 * 路由先判定 kb_route，再在 search 时按 source **硬过滤**。
 *
 * ## 模拟方式（不上动态上传）
 * StoredChunk.source = 入库文件名。映射表：
 *   stage3-rag-notes.md     → notes
 *   stage5-hr-policy-notes.md → hr_policy
 * 入库：npm run rag:ingest
 *       npm run rag:ingest -- docs-sample/stage5-hr-policy-notes.md
 *
 * ## 开关
 * RAG_KB_ROUTE=1 才启用路由过滤；默认 disabled（全库搜，与改前一致）。
 * RAG_KB_ROUTE_FORCE=notes|hr_policy|none|all 可强制路由（验收「错库」用）。
 *
 * 红线：禁止只用 prompt「请忽略其它类」代替本层过滤。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第五部分
 */

import { parseIntent } from "./parseIntent.js";
import type { KbRoute, KbRouteMeta, QueryIntent, RewriteMeta } from "./types.js";

/** 教学用 collection 名 */
export type { KbRoute };

/** 文件名 → 逻辑库；未登记的 source 在启用路由时默认不进任何窄库（避免脏数据乱入） */
const SOURCE_TO_ROUTE: Record<string, Exclude<KbRoute, "none" | "all">> = {
  "stage3-rag-notes.md": "notes",
  "stage5-hr-policy-notes.md": "hr_policy",
};

const HR_HINTS = ["请假", "病假", "事假", "入职", "材料", "社保", "人事", "OA", "证件照", "银行卡"];
const NOTES_HINTS = [
  "chunk",
  "切分",
  "overlap",
  "embedding",
  "向量",
  "检索",
  "RAG",
  "笔记",
  "重排",
  "闸门",
  "prompt",
];

const FORCE_SET = new Set<KbRoute>(["notes", "hr_policy", "none", "all"]);

/** 与扩写开关独立，对照实验一次只开一个 */
export function isKbRouteEnabled(): boolean {
  const raw = (process.env.RAG_KB_ROUTE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** 验收用：强制路由，覆盖规则判定 */
export function getForcedKbRoute(): KbRoute | null {
  const raw = (process.env.RAG_KB_ROUTE_FORCE ?? "").trim() as KbRoute;
  if (FORCE_SET.has(raw)) return raw;
  return null;
}

/** 某逻辑库对应哪些 source 文件名 */
export function sourcesForRoute(route: KbRoute): string[] | null {
  if (route === "all") return null; // null = 不过滤
  if (route === "none") return []; // 空数组 = 候选池为空
  return Object.entries(SOURCE_TO_ROUTE)
    .filter(([, r]) => r === route)
    .map(([source]) => source);
}

export function routeOfSource(source: string): Exclude<KbRoute, "none" | "all"> | null {
  return SOURCE_TO_ROUTE[source] ?? null;
}

function hitAny(text: string, hints: string[]): string[] {
  return hints.filter((h) => text.toLowerCase().includes(h.toLowerCase()));
}

/**
 * 规则路由（教学默认，不强制再调一次 LLM）。
 *
 * 顺序：
 * 1. weather / time / chitchat → none（不搜知识库）
 * 2. 制度关键词 → hr_policy
 * 3. 技术/笔记关键词 → notes
 * 4. 否则 → notes（偏技术课默认库；也可用 all，但噪声更大）
 */
export function routeKbByRules(
  question: string,
  intentHint?: QueryIntent | null,
): { route: KbRoute; reason: string } {
  const trimmed = question.trim();
  const intent = intentHint ?? parseIntent(trimmed)?.intent ?? null;

  if (intent === "weather" || intent === "time" || intent === "chitchat") {
    return { route: "none", reason: `intent=${intent} → 跳过知识库` };
  }

  const hrHits = hitAny(trimmed, HR_HINTS);
  const noteHits = hitAny(trimmed, NOTES_HINTS);

  if (hrHits.length > 0 && hrHits.length >= noteHits.length) {
    return { route: "hr_policy", reason: `命中制度词: ${hrHits.join(",")}` };
  }
  if (noteHits.length > 0) {
    return { route: "notes", reason: `命中笔记词: ${noteHits.join(",")}` };
  }

  return { route: "notes", reason: "默认 notes（开放域偏技术笔记）" };
}

export interface ResolveKbRouteInput {
  /** 用于关键词匹配的文本（建议用户原句；也可用 queryUsed） */
  question: string;
  /** 扩写 meta 里的 intent，可减少与 parseIntent 重复 */
  rewriteMeta?: RewriteMeta | null;
  /** 调用方强制（优先于 env FORCE） */
  forceRoute?: KbRoute | null;
}

/**
 * 产出 KbRouteMeta。
 * disabled 时 route=all、不过滤，保持与单元 5 之前全库行为一致。
 */
export function resolveKbRoute(input: ResolveKbRouteInput): KbRouteMeta {
  const forced = input.forceRoute ?? getForcedKbRoute();

  if (!isKbRouteEnabled() && forced == null) {
    return {
      route: "all",
      status: "disabled",
      sourcesAllowed: null,
      reason: "RAG_KB_ROUTE 未开启",
    };
  }

  if (forced != null) {
    return {
      route: forced,
      status: "forced",
      sourcesAllowed: sourcesForRoute(forced),
      reason: `强制路由 RAG_KB_ROUTE_FORCE/参数=${forced}`,
    };
  }

  const intentHint = input.rewriteMeta?.intent ?? null;
  const { route, reason } = routeKbByRules(input.question, intentHint);
  return {
    route,
    status: "ok",
    sourcesAllowed: sourcesForRoute(route),
    reason,
  };
}
