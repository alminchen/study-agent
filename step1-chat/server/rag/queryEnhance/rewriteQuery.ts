/**
 * 单元 3：LLM 结构化意图 + 单路问句扩写。
 *
 * ## 解决什么
 * 规则盖不住「chunk 怎么切」这类口语。用一次 LLM 调用产出：
 * intent / slots / keywords / rewritten（一条检索句）。
 *
 * ## 硬约束（写进 system，也要在代码里守住）
 * 1. 只理解与扩写，禁止回答用户问题（否则 rewritten 会变成答案正文，向量更脏）
 * 2. 默认只用当前问句，不塞多轮 history（避免「根据上文」污染）
 * 3. temperature 偏低，减少主题漂移
 * 4. 非法 JSON / 缺 rewritten → throw；由单元 4 resolveQueryForRetrieve 回退原句
 * 5. 有 LLM 调用时必须 parseUsage + onUsage（与 completeRagMessages 对齐），否则 Token 面板漏计扩写
 *
 * ## 与规则层关系
 * 先 parseIntent：闲聊可跳过 LLM（省 Token）；规则预判可当 hint，但以模型 JSON 为准。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第三部分
 */

import { parseUsageFromResponse } from "../../usage/parseUsage.js";
import type { TokenUsage } from "../../usage/types.js";
import { parseIntent } from "./parseIntent.js";
import type { QueryIntent, RewriteResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/**
 * 改写专用 system：角色是「检索问句改写器」，不是助手。
 * 要求「仅一行 JSON」是为了 parseRewriteJson 稳定；模型仍可能包 ```，下面会剥 fence。
 */
const REWRITE_SYSTEM = `你是检索问句改写器，不是问答助手。
根据用户原句输出【仅一行】合法 JSON，不要 Markdown 代码块，不要解释。

字段：
- intent: 枚举 weather | time | kb_search | chitchat | unknown
- slots: 对象，可含 city / time / topic（没有就省略或空对象）
- keywords: 字符串数组，2～6 个有助于检索的词
- rewritten: 一条更适合向量检索的中文问句（对齐知识库表述；不确定时可接近原句）

规则：
1. 不要回答用户的问题，不要输出答案正文。
2. 闲聊（你好/谢谢）→ intent=chitchat，rewritten 可等于原句。
3. 天气/时间口语 → 拆出 slots，rewritten 可保留城市与时间线索。
4. 问资料/笔记/技术概念 → intent=kb_search，rewritten 用更完整的检索表述。
5. 禁止编造用户没提的专有名词；禁止在 rewritten 里写「根据上文」。`;

const INTENT_SET = new Set<QueryIntent>([
  "weather",
  "time",
  "kb_search",
  "chitchat",
  "unknown",
]);

/** 模型偶发包 ```json ... ```；剥掉再 parse，避免无谓 fallback */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fence?.[1]?.trim() ?? trimmed;
}

function asIntent(value: unknown): QueryIntent {
  if (typeof value === "string" && INTENT_SET.has(value as QueryIntent)) {
    return value as QueryIntent;
  }
  // 非法枚举不 throw：降成 unknown，但 rewritten 仍必须有（见下）
  return "unknown";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asSlots(value: unknown): RewriteResult["slots"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const slots: RewriteResult["slots"] = {};
  if (typeof row.city === "string" && row.city.trim()) slots.city = row.city.trim();
  if (typeof row.time === "string" && row.time.trim()) slots.time = row.time.trim();
  if (typeof row.topic === "string" && row.topic.trim()) slots.topic = row.topic.trim();
  return slots;
}

/**
 * 把模型输出收成 RewriteResult。
 * 失败一律 throw（不要返回「半成功」对象），上层才能统一 fallback。
 */
export function parseRewriteJson(raw: string): RewriteResult {
  const text = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`rewrite JSON 解析失败: ${text.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("rewrite JSON 必须是对象");
  }
  const row = parsed as Record<string, unknown>;
  const rewritten =
    typeof row.rewritten === "string" && row.rewritten.trim()
      ? row.rewritten.trim()
      : null;
  // rewritten 是进 embed 的唯一字段，缺了就没有「扩写成功」可言
  if (!rewritten) {
    throw new Error("rewrite JSON 缺少非空 rewritten");
  }
  return {
    intent: asIntent(row.intent),
    slots: asSlots(row.slots),
    keywords: asStringArray(row.keywords),
    rewritten,
  };
}

export interface RewriteQueryOptions {
  /** 用户停止生成时中止扩写 HTTP，避免空耗 */
  signal?: AbortSignal;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /**
   * true（默认）：规则已判 chitchat 则不调 LLM，rewritten=原句。
   * 闲聊扩写成知识库问句只会浪费 Token 且污染检索。
   */
  skipLlmOnChitchat?: boolean;
  /** 解析到 usage 后回调（通常 bindUsageCallback(acc, "ragRewrite")） */
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/**
 * 对当前问句做意图 + 单路扩写。
 *
 * 成功 → RewriteResult（调用方取 .rewritten 去 embed）
 * 失败 → throw（不要在这里吞掉；回退策略集中在 resolveQueryForRetrieve）
 */
export async function rewriteQuery(
  question: string,
  options: RewriteQueryOptions = {},
): Promise<RewriteResult> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error("rewriteQuery: 问句为空");
  }

  // ---- 规则预判：闲聊短路 ----
  const skipChitchat = options.skipLlmOnChitchat !== false;
  const ruled = parseIntent(trimmed);
  if (skipChitchat && ruled?.intent === "chitchat") {
    return {
      intent: "chitchat",
      slots: ruled.slots,
      keywords: ruled.keywords,
      rewritten: trimmed,
    };
  }

  // ---- 真 LLM：与 RAG complete 一样，禁止 MOCK / 无 Key 装成功 ----
  const apiKey = options.apiKey ?? process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    throw new Error("rewriteQuery 需要真实 LLM_API_KEY，且不要 MOCK_MODE=1");
  }

  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const model = options.model || process.env.LLM_MODEL || "deepseek-chat";

  // 规则结果当 hint，减少漂移；仍写明「以你判断为准」，避免模型被错误规则锁死
  const hint =
    ruled != null
      ? `\n（规则预判 intent=${ruled.intent} slots=${JSON.stringify(ruled.slots)}，可参考但以你判断为准）`
      : "";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // 低温度：扩写要稳，不要每次漂到不同主题
      temperature: 0.2,
      messages: [
        { role: "system", content: REWRITE_SYSTEM },
        // 刻意不传 history：检索句应只反映「当前这一问」
        { role: "user", content: `原句：${trimmed}${hint}` },
      ],
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`rewriteQuery LLM 失败 (${response.status}): ${raw.slice(0, 200)}`);
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  // 与 completeRagMessages 对齐：有 usage 就上报，chitchat 短路不进这里
  const usage = parseUsageFromResponse(data);
  if (usage) {
    options.onUsage?.(usage, model);
  }
  const content = data.choices?.[0]?.message?.content ?? "";
  return parseRewriteJson(content);
}
