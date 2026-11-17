/**
 * 结构化摘要生成器：把被丢弃的原始消息压成一份可校验、可回退的摘要。
 *
 * 这是「长上下文管理」里唯一一个会额外调用模型的地方，所以它的失败策略是
 * **收敛到 null，而不是抛异常**：摘要生成失败只是少一份早期记忆，
 * 绝不能连带把聊天打断（决策四）。
 *
 * 三条设计要点：
 * 1. **模型只做它擅长的事**：把一段历史压成四个结构化数组。
 *    老摘要的合并、截断、去重全在服务端用代码做，不指望模型记住旧内容。
 * 2. **来源下标由服务端给**：每条待摘要消息都带一个 `[n]` 编号，
 *    模型只需要原样抄回这个编号，服务端再校验它是否合法。
 * 3. **失败一律返回 null**：超时、非 200、非法 JSON、带 code fence、
 *    schema 校验失败、条目一个都不剩——全部返回 null，调用方按「无摘要」继续。
 */
import { z } from "zod";

import type { TextMessage } from "../react/types.js";
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import { estimateMessagesTokens } from "./tokenBudget.js";
import {
  CONTEXT_SUMMARY_VERSION,
  type ContextSummary,
  type ContextSummaryItem,
  type ContextBuildResult,
} from "./types.js";

/** 摘要正文的字符上限（不含渲染时的标题与来源标记）。 */
export const SUMMARY_CONTENT_MAX_CHARS = 1200;

/** 单条摘要条目的最大字符数。 */
export const SUMMARY_ITEM_MAX_CHARS = 120;

/** 事实 key 的最大字符数。 */
const SUMMARY_FACT_KEY_MAX_CHARS = 80;

/** 每类最多保留多少条。 */
export const SUMMARY_ITEMS_PER_CATEGORY = 12;

/** 送进模型的待摘要文本上限；超了取头尾两段，中间显式省略。 */
const TRANSCRIPT_MAX_CHARS = 16000;

/** 摘要请求的总超时。 */
const SUMMARY_TIMEOUT_MS = 30_000;

/** 摘要最多允许生成多少 token。 */
const SUMMARY_MAX_TOKENS = 1500;

/** 摘要用低温度：要稳定复现，不要创造力。 */
const SUMMARY_TEMPERATURE = 0.2;

/** 触发摘要生成的门槛：丢掉的消息条数。太少了不值得多调一次模型。 */
export const SUMMARY_TRIGGER_MIN_MESSAGES = 2;

/** 触发摘要生成的门槛：丢掉部分的估算 token。 */
export const SUMMARY_TRIGGER_MIN_TOKENS = 200;

/** 四个类别的固定处理顺序，也就是截断时的优先级。 */
const CATEGORY_ORDER = ["userConstraints", "facts", "decisions", "unresolved"] as const;

type CategoryName = (typeof CATEGORY_ORDER)[number];

/**
 * 模型输出的最小契约。
 *
 * `facts` 是必填：缺了它说明模型没按形状输出，整份摘要作废。
 * 另外三类缺省为空数组——「这一类没有内容」是合法结果，不该让整份摘要失败。
 *
 * `sourceMessageIndex` 在条目层面是可选的：校验阶段先放过，
 * 后面再按「缺失即丢弃」逐条过滤。这样「某一条没带下标」只损失那一条，
 * 而「整个 facts 字段没了」才会让整份摘要返回 null。
 *
 * **单条文本的长度不在 schema 里限制**：模型偶尔写超长是常态，
 * 让一条超长就把整份摘要作废太脆。长度改由代码裁剪（clampItemText）。
 */
const RawSummaryItemSchema = z.object({
  text: z.string().min(1),
  sourceMessageIndex: z.number().int().optional(),
});

const RawSummaryFactSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  sourceMessageIndex: z.number().int().optional(),
});

const RawSummarySchema = z.object({
  facts: z.array(RawSummaryFactSchema),
  decisions: z.array(RawSummaryItemSchema).default([]),
  unresolved: z.array(RawSummaryItemSchema).default([]),
  userConstraints: z.array(RawSummaryItemSchema).default([]),
});

export interface SummarizeDroppedMessagesParams {
  /** 被丢弃的原始消息（顺序与 droppedMessageIndices 一致）。 */
  droppedMessages: TextMessage[];
  /** 每条 droppedMessage 在**原始 messages 数组**里的下标。 */
  droppedMessageIndices: number[];
  /** 客户端已有的摘要，本次结果会与它合并。 */
  previousSummary?: ContextSummary | null;
  apiKey: string;
  baseUrl: string;
  model?: string;
  /** 用户中止信号。 */
  signal?: AbortSignal;
  /** 总超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 摘要这次模型调用的 token 用量，单独记账。 */
  onUsage?: (usage: TokenUsage, model: string) => void;
  /** 摘要正文字符上限，默认 1200。 */
  maxContentChars?: number;
}

/** 摘要专用 system prompt：要形状明确、要它别写字。 */
function buildSummarySystemPrompt(): string {
  return [
    "你是一个对话摘要器。把给定的历史对话压缩成结构化 JSON。",
    "只输出一个 JSON 对象，不要输出解释、前后缀或 Markdown code fence。",
    "JSON 形状（四个字段都必须出现，没有内容的给空数组）：",
    '{"facts":[{"key":"标识","value":"事实","sourceMessageIndex":0}],',
    '"decisions":[{"text":"已确定的事项","sourceMessageIndex":0}],',
    '"unresolved":[{"text":"还没定下来的事项","sourceMessageIndex":0}],',
    '"userConstraints":[{"text":"用户明确提出的要求","sourceMessageIndex":0}]}',
    "规则：",
    "1. sourceMessageIndex 必须原样抄写输入行开头的 [n] 编号，不能估算或改动。",
    "2. facts 记录客观事实（技术栈、命名、编号、偏好），key 用简短的小写英文标识。",
    "3. decisions 记录已经做出的决定；unresolved 记录用户提了但还没解决的问题。",
    "4. userConstraints 记录用户明确提出的行为要求（语言、格式、禁止项）。",
    "5. 只记录对话里真实出现过的内容，不要推测、不要编造、不要加原文没有的信息。",
    `6. 每类最多 ${SUMMARY_ITEMS_PER_CATEGORY} 条，每条 text/value 不超过 ${SUMMARY_ITEM_MAX_CHARS} 个字符。`,
  ].join("\n");
}

/**
 * 把待摘要消息拼成带编号的转写文本。
 *
 * 编号用**原始 messages 数组的下标**，这样模型抄回来的 sourceMessageIndex
 * 直接就是摘要条目的来源下标，服务端拿它和合法下标集合一比就知道该不该留。
 */
function buildTranscript(messages: TextMessage[], indices: number[]): string | null {
  const lines: string[] = [];
  for (let position = 0; position < messages.length; position += 1) {
    const content = messages[position].content.trim();
    if (!content) continue;
    lines.push(`[${indices[position]}] ${messages[position].role}: ${content}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

/** 转写过长时取头尾两段，中间显式标注省略，避免「看起来完整、实际缺一块」。 */
function clampTranscript(transcript: string): string {
  if (transcript.length <= TRANSCRIPT_MAX_CHARS) return transcript;
  const headLength = Math.floor(TRANSCRIPT_MAX_CHARS * 0.6);
  const tailLength = TRANSCRIPT_MAX_CHARS - headLength;
  const omitted = transcript.length - headLength - tailLength;
  const head = transcript.slice(0, headLength);
  const tail = transcript.slice(-tailLength);
  return `${head}\n……（中间 ${omitted} 个字符已省略）……\n${tail}`;
}

/** 一次性请求的结果：只保留能用的部分，错误统一折叠成失败。 */
interface RawFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

/** 发一次请求；任何异常（网络、超时、中止）都折叠成失败。 */
async function requestOnce(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<RawFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: text };
  } catch {
    // 网络失败、超时、用户中止：都不该让聊天失败，返回失败即可。
    return { ok: false, status: 0, body: "" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** 从非流式响应里取出模型正文。 */
function extractContent(body: string): string {
  try {
    const data = JSON.parse(body) as {
      choices?: { message?: { content?: string | null } }[];
    };
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  } catch {
    return "";
  }
}

/** 从响应里取出 usage 并上报（摘要这次调用单独记账）。 */
function reportUsage(
  body: string,
  model: string,
  onUsage?: (usage: TokenUsage, model: string) => void,
) {
  if (!onUsage) return;
  try {
    const usage = parseUsageFromResponse(JSON.parse(body));
    if (usage) onUsage(usage, model);
  } catch {
    // usage 拿不到不影响摘要本身，静默跳过。
  }
}

/**
 * 解析模型正文里的 JSON。
 *
 * 注意：**不剥 Markdown code fence**。模型被要求直接输出 JSON，
 * 真给了 fence 就说明它没听话，这份摘要不可信，直接判失败。
 */
function parseModelJson(
  content: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, reason: "empty_content" };
  if (trimmed.startsWith("```")) return { ok: false, reason: "markdown_code_fence" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

/** 条目去重与合并时用的内部形状。 */
interface CandidateItem {
  text: string;
  sourceMessageIndex: number;
}

interface CandidateFact {
  key: string;
  value: string;
  sourceMessageIndex: number;
}

/** 过滤掉没有合法来源下标的条目，并按「同类只留最新一条」去重。 */
function normalizeItems(
  rawItems: z.infer<typeof RawSummaryItemSchema>[],
  validIndices: Set<number>,
): CandidateItem[] {
  const byText = new Map<string, CandidateItem>();
  for (const item of rawItems) {
    const index = item.sourceMessageIndex;
    // 缺下标、或下标不在本次待摘要范围里 → 这条无法回溯，丢弃。
    if (typeof index !== "number" || !validIndices.has(index)) continue;
    const text = item.text.trim();
    if (!text) continue;
    const clamped = clampItemText(text, SUMMARY_ITEM_MAX_CHARS);
    const existing = byText.get(clamped);
    if (!existing || index > existing.sourceMessageIndex) {
      byText.set(clamped, { text: clamped, sourceMessageIndex: index });
    }
  }
  return [...byText.values()].sort(
    (left, right) => right.sourceMessageIndex - left.sourceMessageIndex,
  );
}

/** 事实按 key 去重：同一个 key 保留最新的一条。 */
function normalizeFacts(
  rawFacts: z.infer<typeof RawSummaryFactSchema>[],
  validIndices: Set<number>,
): CandidateFact[] {
  const byKey = new Map<string, CandidateFact>();
  for (const fact of rawFacts) {
    const index = fact.sourceMessageIndex;
    if (typeof index !== "number" || !validIndices.has(index)) continue;
    const key = fact.key.trim();
    const value = fact.value.trim();
    if (!key || !value) continue;
    const clampedKey = clampItemText(key, SUMMARY_FACT_KEY_MAX_CHARS);
    const clampedValue = clampItemText(value, SUMMARY_ITEM_MAX_CHARS);
    const existing = byKey.get(key);
    if (!existing || index > existing.sourceMessageIndex) {
      byKey.set(key, {
        key: clampedKey,
        value: clampedValue,
        sourceMessageIndex: index,
      });
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.sourceMessageIndex - left.sourceMessageIndex,
  );
}

/** 旧摘要转成内部形状。 */
function normalizePrevious(summary: ContextSummary | null | undefined): {
  userConstraints: CandidateItem[];
  facts: CandidateFact[];
  decisions: CandidateItem[];
  unresolved: CandidateItem[];
} {
  if (!summary) return { userConstraints: [], facts: [], decisions: [], unresolved: [] };
  const items = (list: ContextSummaryItem[]) =>
    list
      .filter((item) => typeof item?.text === "string" && item.text.trim().length > 0)
      .map((item) => ({
        text: clampItemText(item.text.trim(), SUMMARY_ITEM_MAX_CHARS),
        sourceMessageIndex: item.sourceMessageIndex,
      }))
      .sort((left, right) => right.sourceMessageIndex - left.sourceMessageIndex);
  const facts: CandidateFact[] = summary.facts
    .filter((fact) => typeof fact?.key === "string" && typeof fact?.value === "string")
    .map((fact) => ({
      key: clampItemText(fact.key.trim(), SUMMARY_FACT_KEY_MAX_CHARS),
      value: clampItemText(fact.value.trim(), SUMMARY_ITEM_MAX_CHARS),
      sourceMessageIndex: fact.sourceMessageIndex,
    }))
    .filter((fact) => fact.key.length > 0 && fact.value.length > 0)
    .sort((left, right) => right.sourceMessageIndex - left.sourceMessageIndex);
  return {
    userConstraints: items(summary.userConstraints),
    facts,
    decisions: items(summary.decisions),
    unresolved: items(summary.unresolved),
  };
}

/** 一条内容占多少字符（事实按 "key = value" 算）。 */
function itemCost(category: CategoryName, item: CandidateItem | CandidateFact): number {
  if (category === "facts") {
    const fact = item as CandidateFact;
    return fact.key.length + fact.value.length + 3;
  }
  return (item as CandidateItem).text.length;
}

/** 把一条内容裁到指定字符数（裁完长度严格不超过 maxChars）。 */
function clampItemText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars === 1) return "…";
  return `${text.slice(0, maxChars - 1)}…`;
}

/** 裁短后至少要剩这么多字符才值得保留，否则整条丢掉。 */
const MIN_ITEM_CHARS = 12;

/** 四类内容的内部容器（合并、去重、限长都在这个形状上进行）。 */
interface CategoryBuckets {
  userConstraints: CandidateItem[];
  facts: CandidateFact[];
  decisions: CandidateItem[];
  unresolved: CandidateItem[];
}

/** 把一条事实裁进给定字符预算：key 保留，value 裁短。 */
function clampFactToFit(fact: CandidateFact, maxChars: number): CandidateFact | null {
  const overhead = fact.key.length + 3;
  if (maxChars <= overhead) return null;
  const value = clampItemText(fact.value, maxChars - overhead);
  if (!value) return null;
  return { key: fact.key, value, sourceMessageIndex: fact.sourceMessageIndex };
}

/**
 * 按「用户约束 > 事实 > 决定 > 未决事项」的优先级裁剪摘要长度。
 *
 * 三条规则：
 * 1. 优先级高的类别先占预算，预算用完后面的类别就没了；
 * 2. 同一类别里装不下的整条会裁短后保留（只要预算还剩得下最小长度）；
 * 3. 某一类一个都放不下时，裁短它的第一条再保留——
 *    宁可内容短一点，也不要整类丢掉（比如用户约束整体超长时，至少保住一条约束）。
 */
function applyContentLimit(buckets: CategoryBuckets, maxChars: number): CategoryBuckets {
  const result: CategoryBuckets = {
    userConstraints: [],
    facts: [],
    decisions: [],
    unresolved: [],
  };
  let remaining = Math.max(0, maxChars);

  for (const category of CATEGORY_ORDER) {
    if (category === "facts") {
      const kept: CandidateFact[] = [];
      const deferred: CandidateFact[] = [];
      for (const fact of buckets.facts) {
        if (kept.length >= SUMMARY_ITEMS_PER_CATEGORY) break;
        const cost = itemCost("facts", fact);
        if (cost <= remaining) {
          kept.push(fact);
          remaining -= cost;
        } else {
          deferred.push(fact);
        }
      }
      if (kept.length === 0 && deferred.length > 0 && remaining >= MIN_ITEM_CHARS) {
        const clamped = clampFactToFit(deferred[0], remaining);
        if (clamped) {
          kept.push(clamped);
          remaining = 0;
        }
      }
      result.facts = kept;
    } else {
      const kept: CandidateItem[] = [];
      const deferred: CandidateItem[] = [];
      for (const item of buckets[category]) {
        if (kept.length >= SUMMARY_ITEMS_PER_CATEGORY) break;
        const cost = itemCost(category, item);
        if (cost <= remaining) {
          kept.push(item);
          remaining -= cost;
        } else {
          deferred.push(item);
        }
      }
      if (kept.length === 0 && deferred.length > 0 && remaining >= MIN_ITEM_CHARS) {
        const text = clampItemText(deferred[0].text, remaining);
        if (text) {
          kept.push({ text, sourceMessageIndex: deferred[0].sourceMessageIndex });
          remaining = 0;
        }
      }
      result[category] = kept;
    }
    if (remaining <= 0) break;
  }

  return result;
}

/**
 * 合并新旧条目：按 text 去重，保留来源更晚的那条。
 *
 * 为什么保留更晚的：同一条约束/事实在后面的对话里被修正过，
 * 旧的说法已经被覆盖了。旧条目全部来自上一轮摘要，来源下标天然更小。
 */
function mergeItems(previous: CandidateItem[], fresh: CandidateItem[]): CandidateItem[] {
  const byText = new Map<string, CandidateItem>();
  for (const item of [...previous, ...fresh]) {
    const existing = byText.get(item.text);
    if (!existing || item.sourceMessageIndex > existing.sourceMessageIndex) {
      byText.set(item.text, item);
    }
  }
  return [...byText.values()].sort(
    (left, right) => right.sourceMessageIndex - left.sourceMessageIndex,
  );
}

/** 合并新旧事实：按 key 去重，保留来源更晚的那条（同一个 key 的值可能被改过）。 */
function mergeFacts(previous: CandidateFact[], fresh: CandidateFact[]): CandidateFact[] {
  const byKey = new Map<string, CandidateFact>();
  for (const fact of [...previous, ...fresh]) {
    const existing = byKey.get(fact.key);
    if (!existing || fact.sourceMessageIndex > existing.sourceMessageIndex) {
      byKey.set(fact.key, fact);
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.sourceMessageIndex - left.sourceMessageIndex,
  );
}

/** 把内部容器转回对外的摘要结构。 */
function toContextSummary(
  buckets: CategoryBuckets,
  compactedUntilIndex: number,
  compactedUntilMessageId: string | null,
): ContextSummary {
  return {
    version: CONTEXT_SUMMARY_VERSION,
    updatedAt: Date.now(),
    compactedUntilMessageId,
    compactedUntilIndex,
    facts: buckets.facts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      sourceMessageIndex: fact.sourceMessageIndex,
    })),
    decisions: buckets.decisions.map((item) => ({ ...item })),
    unresolved: buckets.unresolved.map((item) => ({ ...item })),
    userConstraints: buckets.userConstraints.map((item) => ({ ...item })),
  };
}

/** 摘要请求的结果：要么拿到校验过的结构，要么什么都没有。 */
interface SummaryRequestOutcome {
  ok: boolean;
  raw: z.infer<typeof RawSummarySchema> | null;
}

/**
 * 向模型要一份结构化摘要，并把所有失败收敛成 `ok: false`。
 *
 * 重试策略只有一种：**400 才重试**。
 * 400 说明请求参数不被这个兼容层接受（最常见是不认 `response_format`），
 * 退一步换个参数形状重发还有救；401/429/5xx 是真实错误，重试只是浪费配额。
 *
 * 三次尝试分别是：
 * 1. 标准形状 + JSON mode（优先拿最结构化的输出）；
 * 2. 去掉 JSON mode，只靠 prompt 约束（部分兼容层不认 `response_format`）；
 * 3. 再关掉思考模式（有些代理开着思考模式时会拒绝 JSON mode）。
 */
async function requestSummary(
  url: string,
  apiKey: string,
  model: string,
  transcript: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onUsage?: (usage: TokenUsage, model: string) => void,
): Promise<SummaryRequestOutcome> {
  const baseBody: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: buildSummarySystemPrompt() },
      { role: "user", content: transcript },
    ],
    temperature: SUMMARY_TEMPERATURE,
    max_tokens: SUMMARY_MAX_TOKENS,
    stream: false,
  };

  const attempts: Record<string, unknown>[] = [
    { ...baseBody, response_format: { type: "json_object" } },
    { ...baseBody },
    { ...baseBody, thinking: { type: "disabled" } },
  ];

  let result: RawFetchResult = { ok: false, status: 0, body: "" };
  for (const body of attempts) {
    result = await requestOnce(url, apiKey, body, signal, timeoutMs);
    if (result.ok) break;
    if (result.status !== 400) break;
  }

  if (!result.ok) {
    console.warn("[context/summarize] 摘要请求失败", { status: result.status });
    return { ok: false, raw: null };
  }

  reportUsage(result.body, model, onUsage);

  const content = extractContent(result.body);
  const parsed = parseModelJson(content);
  if (!parsed.ok) {
    console.warn("[context/summarize] 摘要响应无法解析", { reason: parsed.reason });
    return { ok: false, raw: null };
  }

  const validated = RawSummarySchema.safeParse(parsed.value);
  if (!validated.success) {
    console.warn("[context/summarize] 摘要未通过 schema 校验", {
      issues: validated.error.issues.length,
    });
    return { ok: false, raw: null };
  }

  return { ok: true, raw: validated.data };
}

/**
 * 把被丢弃的原始消息压成一份结构化摘要。
 *
 * **失败一律返回 null，绝不抛异常**（决策四）：摘要只是早期记忆的增强，
 * 拿不到就退化成「只有近期原文的裸窗口」，聊天必须照常继续。
 *
 * 覆盖范围用**下标口径**表达：返回的 `compactedUntilIndex` 表示
 * 「messages[0..compactedUntilIndex] 已经被这份摘要覆盖」，
 * 调用方（buildContext）据此把旧消息丢掉，避免摘要与原文重复。
 */
export async function summarizeDroppedMessages(
  params: SummarizeDroppedMessagesParams,
): Promise<ContextSummary | null> {
  const {
    droppedMessages,
    droppedMessageIndices,
    previousSummary,
    apiKey,
    baseUrl,
    model,
    signal,
    timeoutMs = SUMMARY_TIMEOUT_MS,
    onUsage,
    maxContentChars = SUMMARY_CONTENT_MAX_CHARS,
  } = params;

  // 没有可摘要的内容 → 直接失败。
  if (droppedMessages.length === 0) return null;
  // 下标与消息对不上 → 无法给摘要条目标来源，放弃。
  if (droppedMessages.length !== droppedMessageIndices.length) return null;

  const transcript = buildTranscript(droppedMessages, droppedMessageIndices);
  if (!transcript) return null;

  const effectiveModel = model ?? process.env.LLM_MODEL ?? "deepseek-chat";
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const outcome = await requestSummary(
    url,
    apiKey,
    effectiveModel,
    clampTranscript(transcript),
    signal,
    timeoutMs,
    onUsage,
  );
  if (!outcome.ok || !outcome.raw) return null;

  // 只接受来源下标落在本次待摘要范围内的条目；缺下标的条目直接丢。
  const validIndices = new Set(droppedMessageIndices);
  const fresh: CategoryBuckets = {
    userConstraints: normalizeItems(outcome.raw.userConstraints, validIndices),
    facts: normalizeFacts(outcome.raw.facts, validIndices),
    decisions: normalizeItems(outcome.raw.decisions, validIndices),
    unresolved: normalizeItems(outcome.raw.unresolved, validIndices),
  };

  // 与旧摘要在**服务端**合并，不让模型重述旧内容（模型重述必然失真）。
  const previous = normalizePrevious(previousSummary);
  const merged: CategoryBuckets = {
    userConstraints: mergeItems(previous.userConstraints, fresh.userConstraints),
    facts: mergeFacts(previous.facts, fresh.facts),
    decisions: mergeItems(previous.decisions, fresh.decisions),
    unresolved: mergeItems(previous.unresolved, fresh.unresolved),
  };

  const limited = applyContentLimit(merged, maxContentChars);

  const keptCount =
    limited.userConstraints.length +
    limited.facts.length +
    limited.decisions.length +
    limited.unresolved.length;
  if (keptCount === 0) {
    // 原文被丢掉、却一条都没记住 = 静默丢信息。
    // 这种情况下宁可让调用方回退到裸窗口，也不要假装压缩成功了。
    console.warn("[context/summarize] 摘要为空，放弃压缩");
    return null;
  }

  const compactedUntilIndex = Math.max(
    previousSummary?.compactedUntilIndex ?? -1,
    ...droppedMessageIndices,
  );

  return toContextSummary(
    limited,
    compactedUntilIndex,
    previousSummary?.compactedUntilMessageId ?? null,
  );
}

/**
 * 按需生成一份结构化摘要。
 *
 * 直接不生成（返回 null）的情况：
 * - 没有 API Key：没有真实模型可调；
 * - 丢掉的消息太少 / 太小：多调一次模型不划算。
 *
 * 生成失败（超时、返回非法 JSON、schema 不过）也返回 null，
 * 由调用方回退到「只有近期原文」的裸窗口，聊天照常继续（决策四）。
 */
export async function maybeSummarize(params: {
  context: ContextBuildResult;
  previousSummary: ContextSummary | null;
  apiKey: string;
  baseUrl: string;
  model?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage, model: string) => void;
}): Promise<ContextSummary | null> {
  const { context } = params;
  if (!params.apiKey) return null;
  if (context.droppedMessages.length < SUMMARY_TRIGGER_MIN_MESSAGES) return null;
  if (estimateMessagesTokens(context.droppedMessages) < SUMMARY_TRIGGER_MIN_TOKENS) {
    return null;
  }
  return summarizeDroppedMessages({
    droppedMessages: context.droppedMessages,
    droppedMessageIndices: context.droppedMessageIndices,
    previousSummary: params.previousSummary,
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    signal: params.signal,
    onUsage: params.onUsage,
  });
}
