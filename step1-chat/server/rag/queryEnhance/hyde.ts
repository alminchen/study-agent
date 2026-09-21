/**
 * 单元 7：HyDE（Hypothetical Document Embeddings）。
 *
 * ## 解决什么
 * 短问句向量 ↔ 长文档块向量，空间往往对不齐。
 * 先让 LLM 写一段「像资料里会出现的段落」，再 embed(假文档) 去搜真库。
 *
 * ## 与扩写的差别
 * | | 扩写 rewritten | HyDE hydeDoc |
 * |--|--|--|
 * | 形态 | 仍是问句 | 假想的资料段落 |
 * | embed 对象 | 问句 | 假文档 |
 * | 用途 | 对齐库内术语 | 用「文档对文档」拉近向量空间 |
 *
 * ## 硬约束
 * 1. 假文档不是给用户看的正式回答（UI 仍显示原问）
 * 2. 失败 / 空文 → fallback 用 queryUsed（扩写句或原句）检索
 * 3. 不要为了救胡编假文档去改 MIN_TOP_SCORE
 *
 * ## 开关
 * RAG_HYDE=1；与扩写 / 路由 / Multi-Query 独立。对照时不要与 Multi 同开。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第七部分
 */

import { parseUsageFromResponse } from "../../usage/parseUsage.js";
import type { TokenUsage } from "../../usage/types.js";
import type { HydeMeta } from "./types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** 假文档过长浪费 Token 且易跑题；截断保底 */
export const HYDE_DOC_MAX_CHARS = 600;

/**
 * HyDE 专用 system：写「资料段落」，不是答用户、不是改写问句。
 */
const HYDE_SYSTEM = `你是检索用「假想文档」生成器，不是问答助手。
根据用户问题，写一段【像企业内部笔记 / 技术说明里会出现的中文段落】。

要求：
1. 口吻像资料正文（说明、注意点、步骤），不要写成对用户的直接回答（禁止「你可以…」「建议你…」开头）。
2. 不要编造具体政策数字、人名、未提及的专有产品名；不确定就用通用表述。
3. 篇幅约 120～400 字；不要 Markdown 标题堆砌；不要代码块。
4. 只输出假想文档正文，不要 JSON，不要前言后语。`;

export function isHydeEnabled(): boolean {
  const raw = (process.env.RAG_HYDE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export interface GenerateHydeOptions {
  signal?: AbortSignal;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** 解析到 usage 后回调（通常 bindUsageCallback(acc, "ragHyde")） */
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/** 剥 fence；HyDE 要的是纯段落，偶发包 ``` 也拿掉 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)```$/i);
  return fence?.[1]?.trim() ?? trimmed;
}

/**
 * 调 LLM 生成假想文档。失败 throw，由 resolveHydeQuery 统一 fallback。
 */
export async function generateHydeDoc(
  question: string,
  options: GenerateHydeOptions = {},
): Promise<string> {
  const trimmed = question.trim();
  if (!trimmed) {
    throw new Error("generateHydeDoc: 问句为空");
  }

  const apiKey = options.apiKey ?? process.env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey || process.env.MOCK_MODE === "1") {
    throw new Error("generateHydeDoc 需要真实 LLM_API_KEY，且不要 MOCK_MODE=1");
  }

  const baseUrl = (options.baseUrl ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    "",
  );
  const model = options.model || process.env.LLM_MODEL || "deepseek-chat";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // 略高于扩写：假文档需要一点「像正文」的发挥，但仍要稳住主题
      temperature: 0.4,
      messages: [
        { role: "system", content: HYDE_SYSTEM },
        { role: "user", content: `用户问题：${trimmed}\n请写出假想资料段落：` },
      ],
      stream: false,
    }),
    signal: options.signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`generateHydeDoc LLM 失败 (${response.status}): ${raw.slice(0, 200)}`);
  }

  const data = JSON.parse(raw) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const usage = parseUsageFromResponse(data);
  if (usage) {
    options.onUsage?.(usage, model);
  }
  const content = stripCodeFence(data.choices?.[0]?.message?.content ?? "");
  if (!content || content.length < 40) {
    throw new Error(`generateHydeDoc 假文档过短或为空: ${content.slice(0, 80)}`);
  }
  return content.slice(0, HYDE_DOC_MAX_CHARS);
}

export interface ResolveHydeResult {
  /** 实际交给 embed 的文本：成功=假文档，失败=fallbackQuery */
  embedText: string;
  meta: HydeMeta;
}

/**
 * 开关关闭 → disabled，embedText=fallbackQuery（通常是 queryUsed）。
 * 开关打开 → 成功用假文档；失败不抛，回退 fallbackQuery。
 */
export async function resolveHydeQuery(
  /** 用户原句（写进 meta；生成假文档也优先用原句主题） */
  original: string,
  /** 回退 / 关开关时用于 embed 的问句（扩写句或原句） */
  fallbackQuery: string,
  options: GenerateHydeOptions = {},
): Promise<ResolveHydeResult> {
  const orig = original.trim();
  const fallback = fallbackQuery.trim() || orig;

  if (!isHydeEnabled()) {
    return {
      embedText: fallback,
      meta: {
        status: "disabled",
        original: orig,
        hydeDoc: null,
        embedText: fallback,
        reason: "RAG_HYDE 未开启",
      },
    };
  }

  try {
    // 用原句生成假文档：比用 rewritten 更贴近用户意图；rewritten 已在单路路径里用过
    const hydeDoc = await generateHydeDoc(orig, options);
    return {
      embedText: hydeDoc,
      meta: {
        status: "ok",
        original: orig,
        hydeDoc,
        embedText: hydeDoc,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[hyde] fallback: ${reason}`);
    return {
      embedText: fallback,
      meta: {
        status: "fallback",
        original: orig,
        hydeDoc: null,
        embedText: fallback,
        reason,
      },
    };
  }
}

export function disabledHydeMeta(original = "", embedText = ""): HydeMeta {
  return {
    status: "disabled",
    original,
    hydeDoc: null,
    embedText,
    reason: "RAG_HYDE 未开启",
  };
}
