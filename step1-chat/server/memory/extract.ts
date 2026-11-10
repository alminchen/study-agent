/**
 * 记忆抽取器：从最近几轮对话里抽出「值得跨会话记住」的事实。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 * 专项计划：`tasks/memory-plan.md`
 *
 * 设计取舍：
 * - 只收**明确偏好与项目事实**，不收临时任务、格式要求、模糊表达。
 * - 任何失败都收敛成空数组：抽取器是「锦上添花」的旁路，
 *   挂了就挂了，绝不能把主聊天链路带崩。
 * - 敏感信息两道闸：送模型前脱敏，模型输出后再拦一次。
 * - 模型调用走函数注入（callModel），本文件不出现 fetch，
 *   单测可以塞假模型，真实实现放在同文件的 createMemoryModelCaller。
 */

import { z } from "zod";
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import {
  MEMORY_SOURCES,
  MEMORY_VALUE_MAX_LENGTH,
  MIN_CONFIDENCE,
  clampConfidence,
  normalizeKey,
  type MemoryExtractResult,
} from "./types.js";

// 规范化规则住在 types.ts（API 写入也要用），这里转出去保持旧引用可用。
export { normalizeKey };

/** 抽取器认识的对话消息形状；服务端不依赖前端类型。 */
export interface MemoryConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/** 一次抽取调用交给模型侧的请求内容。 */
export interface MemoryModelRequest {
  /** 抽取规则（system prompt）。 */
  system: string;
  /** 待判断的对话片段。 */
  user: string;
  /** 中止信号：超时或调用方取消。 */
  signal: AbortSignal;
}

/** 模型调用实现；真实实现是 createMemoryModelCaller。 */
export type MemoryModelCaller = (request: MemoryModelRequest) => Promise<string>;

/** 抽取器可调参数。 */
export interface ExtractMemoryOptions {
  /** 必填：模型调用入口。 */
  callModel: MemoryModelCaller;
  /** 归属的匿名用户；非法 userId 直接返回空数组。 */
  userId: string;
  /** 调用方取消信号。 */
  signal?: AbortSignal;
  /** 整次抽取的耗时上限，默认 8000ms。 */
  timeoutMs?: number;
  /** 送进模型的对话文本上限，默认 4000 字符。 */
  maxInputChars?: number;
  /** 最多返回几条候选事实，默认 5。 */
  maxFacts?: number;
  /** 参与抽取的最近轮数，默认 2 轮。 */
  rounds?: number;
}

/** 模型输出的一条候选事实的形状（与 MemoryExtractResult 一一对应）。 */
const ExtractItemSchema = z.object({
  shouldStore: z.boolean(),
  confidence: z.number(),
  key: z.string(),
  value: z.string(),
  reason: z.string(),
  source: z.enum(MEMORY_SOURCES),
});

/**
 * 敏感信息模式表。
 *
 * 这不是为了「安全合规表演」，而是因为记忆是**跨会话长期留存**的：
 * 一次性聊天里说出邮箱无所谓，被存进文件明年还在就很难看了。
 */
const SENSITIVE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "邮箱",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    name: "API Key",
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  { name: "Bearer 令牌", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },
  { name: "IPv4 地址", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  { name: "身份证号", pattern: /\b\d{17}[\dXx]\b/g },
  { name: "手机号", pattern: /\b1[3-9]\d{9}\b/g },
  { name: "银行卡号", pattern: /\b\d{16,19}\b/g },
];

/** 判断文本里是否含有敏感信息。 */
export function containsSensitiveText(text: string): boolean {
  return SENSITIVE_PATTERNS.some(({ pattern }) => {
    // 复用 lastIndex，避免带 g 的正则跨调用串味。
    const re = new RegExp(pattern.source, pattern.flags);
    return re.test(text);
  });
}

/**
 * 把文本里的敏感片段替换成占位符。
 *
 * 用替换而不是整条丢弃：用户一句「以后都用中文，我的邮箱是 xxx@example.com」
 * 里的「中文」是偏好，邮箱才是敏感部分——整条丢掉会误伤。
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), `[已脱敏:${name}]`);
  }
  return result;
}

/**
 * 取最近若干轮对话。
 *
 * 「一轮」= 一条 user 消息 + 它之后的 assistant 回复。
 * 只往前找 rounds 条 user 消息，起点之前的内容全部丢掉——
 * 抽取器要的是「刚才说了什么偏好」，不是整段历史。
 */
export function pickRecentRounds(
  messages: MemoryConversationMessage[],
  rounds: number,
): MemoryConversationMessage[] {
  const usable = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const userIndexes = usable
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userIndexes.length === 0) return [];

  const keepFrom = userIndexes[Math.max(0, userIndexes.length - rounds)];
  return usable.slice(keepFrom);
}

/** 抽取规则（system prompt）。 */
export const MEMORY_EXTRACT_SYSTEM_PROMPT = [
  "你是一个严格的长期记忆抽取器，负责从对话里挑出**值得跨会话记住**的事实。",
  "只输出一个 JSON 数组，不要输出解释、前后缀或 Markdown code fence。",
  "数组里每个元素的形状固定为：",
  '{"shouldStore":boolean,"confidence":number,"key":string,"value":string,"reason":string,"source":string}',
  "",
  "source 只能是下面四个之一：",
  ...MEMORY_SOURCES.map((source) => `- ${source}`),
  "",
  "只输出一个数组，哪怕没有值得记的内容也输出 []。",
  "",
  "判定规则（逐条检查后再决定要不要输出）：",
  "1. 明确偏好：用户说「以后都用中文」「回答别用 emoji」→ shouldStore=true，key 用 language / style 这类语义词。",
  "2. 用户纠正：用户说「不对，我用 React」→ shouldStore=true，source=user_correction。",
  "3. 项目事实：用户说「数据库是 PostgreSQL」「这个项目用 Vue 3」→ shouldStore=true，source=project_fact。",
  "4. 临时任务：「帮我写个测试」「现在给我列个清单」→ shouldStore=false，这是这一轮的事。",
  "5. 格式要求：「回答用 JSON」「给我表格」→ shouldStore=false，这是当前回复格式，不是长期偏好。",
  "6. 敏感信息：邮箱、手机号、密钥、身份证、IP 等 → shouldStore=false，key/value 也不要复述这些内容。",
  "7. 模糊表达：「最好简单点」「差不多就行」→ shouldStore=false，confidence 给 0.3 以下。",
  "8. 工具返回的持久化配置：确认是长期有效的配置（如数据库类型、框架版本）→ shouldStore=true，source=tool_learned_fact。",
  "",
  "key 是简短的语义词（language / framework / style / db / project_name），",
  "value 是具体的事实值（中文 / Vue 3 / 不使用 emoji / PostgreSQL）。",
  "confidence 表示把握程度（0~1）；拿不准就给低分，不要为了凑数虚高。",
  "reason 用一句话说明为什么值得记。",
].join("\n");

/** 把对话片段拼成给模型看的文本，并做脱敏与长度限制。 */
export function buildExtractUserPrompt(
  messages: MemoryConversationMessage[],
  maxInputChars: number,
): string {
  const transcript = messages
    .map((message) => {
      const who = message.role === "user" ? "用户" : "助手";
      return `${who}：${redactSensitiveText(message.content)}`;
    })
    .join("\n");

  if (transcript.length <= maxInputChars) return transcript;
  // 超长时保留尾部：最近的对话才是我们要抽取的部分。
  return `…[前文已截断]\n${transcript.slice(transcript.length - maxInputChars)}`;
}

/**
 * 解析模型输出。
 *
 * 三道关：去掉代码围栏 → JSON.parse → Zod 逐条校验。
 *
 * 逐条而不是整批校验：模型十条里坏一条，不该把另外九条一起丢掉。
 * 整批解析失败才返回空数组（调用方不会拿到半成品）。
 */
export function parseExtractOutput(raw: string): MemoryExtractResult[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: MemoryExtractResult[] = [];
  for (const item of parsed.slice(0, 20)) {
    const result = ExtractItemSchema.safeParse(item);
    if (!result.success) continue;
    results.push({
      shouldStore: result.data.shouldStore,
      // 这里保留模型给的原始置信度，不能提前夹取：
      // clampConfidence 会把 0.35 抬到下限 0.6，
      // 那样「置信度低于 0.6 不存」的规则就永远筛不掉东西了。
      confidence: Number.isFinite(result.data.confidence)
        ? result.data.confidence
        : 0,
      key: result.data.key,
      value: result.data.value,
      reason: result.data.reason,
      source: result.data.source,
    });
  }
  return results;
}

/**
 * 从最近几轮对话里抽取候选事实。
 *
 * 任何失败（超时、模型报错、JSON 非法、schema 不过、userId 非法）
 * 都返回空数组，绝不抛异常——这是「记忆不阻断聊天」的落点。
 */
export async function extractMemoryFacts(
  messages: MemoryConversationMessage[],
  options: ExtractMemoryOptions,
): Promise<MemoryExtractResult[]> {
  const {
    callModel,
    userId,
    timeoutMs = 8_000,
    maxInputChars = 4_000,
    maxFacts = 5,
    rounds = 2,
  } = options;

  if (!userId.startsWith("anon_")) {
    console.warn("[memory] 抽取跳过：userId 非法", { userId });
    return [];
  }

  const recent = pickRecentRounds(messages, rounds);
  if (recent.length === 0) return [];

  // 整段对话全是敏感信息时，连模型都不用调。
  const userText = recent
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  if (userText.length > 0 && containsSensitiveText(userText)) {
    // 只脱敏不丢弃：偏好可能和敏感信息写在同一句里。
    console.debug("[memory] 抽取输入含敏感信息，已脱敏后再送模型");
  }

  const user = buildExtractUserPrompt(recent, maxInputChars);
  if (!user.trim()) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });

  let raw = "";
  try {
    raw = await callModel({
      system: MEMORY_EXTRACT_SYSTEM_PROMPT,
      user,
      signal: controller.signal,
    });
  } catch (error) {
    console.warn("[memory] 抽取失败，已跳过（不影响聊天）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }

  const parsed = parseExtractOutput(raw);
  if (parsed.length === 0) return [];

  // 后置闸门：模型自己声明要存的，也得再过一遍代码规则。
  const accepted: MemoryExtractResult[] = [];
  for (const item of parsed) {
    if (!item.shouldStore) continue;
    // 先用原始置信度做门槛判断，再夹取。
    if (item.confidence < MIN_CONFIDENCE) continue;

    const key = normalizeKey(item.key);
    const value = item.value.trim();
    if (!key || !value) continue;
    if (value.length > MEMORY_VALUE_MAX_LENGTH) continue;
    // 模型若把敏感信息复述进 value，这里再拦一次。
    if (containsSensitiveText(value)) continue;

    accepted.push({
      ...item,
      key,
      value,
      confidence: clampConfidence(item.confidence),
    });
    if (accepted.length >= maxFacts) break;
  }

  return accepted;
}

/** 真实模型调用器的参数。 */
export interface MemoryModelCallerParams {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 是否请求 response_format JSON mode；默认开启。 */
  jsonMode?: boolean;
  /** 采样温度；抽取要稳定，默认 0.1。 */
  temperature?: number;
  /** usage 回调，用于统一记账。 */
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/**
 * 真实模型调用器：一次非流式的 chat/completions。
 *
 * 与 Reflection 的调用器同形，区别只在多了 temperature 和 JSON mode。
 * 不走流式是因为抽取结果很小（一个 JSON 数组），
 * 流式只会让「等一个完整 JSON」的逻辑更绕。
 */
export function createMemoryModelCaller(params: MemoryModelCallerParams): MemoryModelCaller {
  return async (request) => {
    const baseUrl = params.baseUrl.replace(/\/$/, "");
    const body: Record<string, unknown> = {
      model: params.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      stream: false,
      temperature: params.temperature ?? 0.1,
    };
    if (params.jsonMode !== false) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`记忆抽取模型请求失败（${response.status}）：${raw.slice(0, 200)}`);
    }

    const data = JSON.parse(raw) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const usage = parseUsageFromResponse(data);
    if (usage) params.onUsage?.(usage, params.model);

    return data.choices?.[0]?.message?.content ?? "";
  };
}
