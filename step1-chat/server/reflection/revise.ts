/**
 * Reflection 重写生成。
 *
 * 设计思路：
 * - 模型调用同样是注入式（callModel），本文件不出现 fetch、不出现 tools 参数，
 *   从结构上保证重写阶段不可能调用工具
 * - 重写只拿四样东西：原问题、工具事实、原答案、修订指令；不多给任何上下文
 * - 输出是纯文本，不是结构化对象——重写本身没有需要被程序消费的字段
 * - 落地前先过一道"事实守卫"：重写里新出现的事实型 token 必须能在
 *   工具事实或原答案中找到，否则这次重写直接作废、回退初版
 *
 * 分层约定（与 Judge 严格分开）：
 * - Judge 只做安全判定，不改写
 * - Revise 只做质量改进，不做安全判断，也不碰工具执行
 */
import type { ReflectionErrorKind } from "./types.js";
import { stripCodeFence, truncateMiddle } from "./text.js";

/** 重写阶段只可能出现的失败类型：调用层失败与超时。 */
export type ReviseErrorKind = Extract<
  ReflectionErrorKind,
  "timeout" | "api_error"
>;

/** 一次重写调用交给模型侧的请求内容。 */
export interface ReviseModelRequest {
  /** 重写 system prompt。 */
  system: string;
  /** 原问题、工具事实、原答案、修订指令的拼接文本。 */
  user: string;
  /** 本次调用剩余的总预算；调用方应据此自行超时。 */
  timeoutMs: number;
  /** 中止信号。 */
  signal: AbortSignal;
}

/**
 * 模型调用实现。
 *
 * 注意请求里没有 tools / tool_choice 之类的字段——重写阶段没有工具可调，
 * 需要检索的信息必须由调用方在 toolFacts 里给全。
 */
export type ReviseModelCaller = (request: ReviseModelRequest) => Promise<string>;

/** 重写过程的元信息，不参与结果判断。 */
export interface ReviseMeta {
  /** 原答案长度。 */
  originalChars: number;
  /** 实际送入模型的原答案长度。 */
  sentChars: number;
  /** 是否发生截断。 */
  truncated: boolean;
  /** 实际尝试次数（含首次）。 */
  attempts: number;
  /** 重写总耗时。 */
  durationMs: number;
}

/** 重写的调用参数。 */
export interface ReviseOptions {
  /** 必填：模型调用入口。 */
  callModel: ReviseModelCaller;
  /** 送入重写的原答案上限；超出则保留首尾片段。默认 8000。 */
  maxInputChars?: number;
  /** 重写结果上限；超出则截断。默认 8000。 */
  maxOutputChars?: number;
  /** 整次重写（含重试）的耗时上限，默认 10000ms。 */
  totalTimeoutMs?: number;
  /** 最多重试次数，默认 1。 */
  maxRetries?: number;
  /** 重写过程元信息回调，用于写 trace。 */
  onMeta?: (meta: ReviseMeta) => void;
}

/** 重写需要的全部输入，不多给也不少给。 */
export interface ReviseInput {
  /** 用户原始问题。 */
  question: string;
  /** 待修订的答案。 */
  draft: string;
  /** Critic 给出的修订指令。 */
  revisionInstructions: string;
  /** 工具返回的事实；重写只能引用这里出现过的内容。 */
  toolFacts?: string;
}

/** 重写成功并通过事实守卫。 */
export interface ReviseOk {
  status: "ok";
  /** 修订后的答案。 */
  revisedDraft: string;
}

/** 重写结果与原答案实质相同，没必要再评一次分。 */
export interface ReviseNoChange {
  status: "no_change";
  /** 与原答案等价的文本。 */
  revisedDraft: string;
}

/** 重写作废：引入了无依据的新事实，或结果为空。 */
export interface ReviseRejected {
  status: "rejected";
  /** 被作废的重写文本，仅供排查。 */
  revisedDraft: string;
  /** 作废原因。 */
  reason: string;
  /** 检测到的无依据 token。 */
  unsupportedTokens: string[];
}

/** 重写失败：调用层错误或超时。 */
export interface ReviseError {
  status: "error";
  /** 失败类别。 */
  errorKind: ReviseErrorKind;
  /** 已经重试的次数；0 表示首次就失败。 */
  retries: number;
  /** 原始响应片段。 */
  raw: string;
  /** 可读错误描述。 */
  message?: string;
}

/** 重写结果的四条互斥路径。 */
export type ReviseResult = ReviseOk | ReviseNoChange | ReviseRejected | ReviseError;

/** 数字 + 单位：最常见的"新事实"形态。 */
const FACT_WITH_UNIT_PATTERN =
  /\d+(?:\.\d+)?\s*(?:年|月|日|号|天|小时|分钟|秒|元|块|美元|人民币|件|人|次|单|个|台|套|%|％)/g;

/** 引号内的原话：引号里的东西几乎总是"从别处搬来的事实"。 */
const QUOTED_PATTERN =
  /[「『《"]([^」』》"]{1,50})[」』》"]|"([^"]{1,50})"/g;

/** 全大写缩写：UPS / SF 之类的机构简称。 */
const ACRONYM_PATTERN = /\b[A-Z]{2,}\b/g;

/** 多词专有名词：SF Express 这类。 */
const PROPER_NOUN_PATTERN = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;

/**
 * 常见的时间推断词。
 *
 * 这类词几乎不会出现在工具事实里，却经常被模型顺手写进答案
 * （"预计明天送达"），所以单独列出来核对。
 */
const TIME_INFERENCE_TOKENS = [
  "明天",
  "后天",
  "昨天",
  "次日",
  "今晚",
  "明早",
  "下周",
  "下星期",
  "下个月",
  "明年",
];

/** 超时错误；与业务错误区分。 */
class ReviseTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviseTimeoutError";
  }
}

/**
 * 基于原答案做一次修订。
 *
 * 顺序固定：截断 → 拼提示词 → 调用 → 去围栏 → 事实守卫 → 判定结果。
 * 失败一律收敛成结果对象，不向外抛异常，也绝不返回半成品改写。
 */
export async function revise(
  input: ReviseInput,
  options: ReviseOptions,
): Promise<ReviseResult> {
  const startedAt = Date.now();
  const maxInputChars = options.maxInputChars ?? 8_000;
  const maxOutputChars = options.maxOutputChars ?? 8_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 1;

  const instructions = input.revisionInstructions.trim();
  if (instructions.length === 0) {
    return {
      status: "rejected",
      revisedDraft: "",
      reason: "缺少修订指令，不执行重写",
      unsupportedTokens: [],
    };
  }

  const truncated = truncateMiddle(input.draft, maxInputChars);
  const request = buildReviseRequest(input, instructions, truncated.text);

  let attempts = 0;
  let lastError: { kind: ReviseErrorKind; message: string } = {
    kind: "api_error",
    message: "重写未开始",
  };

  const emitMeta = (): void => {
    options.onMeta?.({
      originalChars: input.draft.length,
      sentChars: truncated.text.length,
      truncated: truncated.truncated,
      attempts,
      durationMs: Date.now() - startedAt,
    });
  };

  while (attempts <= maxRetries) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      lastError = { kind: "timeout", message: "重写总时长已耗尽" };
      break;
    }

    attempts += 1;
    try {
      const raw = await callWithDeadline(request, remaining, options.callModel);
      const result = evaluateRevision(input, raw, maxOutputChars);
      emitMeta();
      return result;
    } catch (error) {
      if (error instanceof ReviseTimeoutError) {
        lastError = { kind: "timeout", message: error.message };
        continue;
      }
      lastError = {
        kind: "api_error",
        message: error instanceof Error ? error.message : "模型调用失败",
      };
    }
  }

  emitMeta();
  return {
    status: "error",
    errorKind: lastError.kind,
    retries: Math.max(0, attempts - 1),
    raw: "",
    message: lastError.message,
  };
}

/**
 * 判定一次重写的结果。
 *
 * 三条规则依次生效：
 * 1. 结果为空 → rejected；
 * 2. 出现无依据的新事实 → rejected（上层回退初版）；
 * 3. 与原答案实质相同 → no_change（上层不必再花一轮评分）。
 */
function evaluateRevision(
  input: ReviseInput,
  raw: string,
  maxOutputChars: number,
): ReviseResult {
  const cleaned = stripCodeFence(raw).trim();
  if (cleaned.length === 0) {
    return {
      status: "rejected",
      revisedDraft: "",
      reason: "重写结果为空",
      unsupportedTokens: [],
    };
  }

  const revisedDraft =
    cleaned.length > maxOutputChars
      ? truncateMiddle(cleaned, maxOutputChars).text
      : cleaned;

  const unsupportedTokens = detectUnsupportedFacts(revisedDraft, [
    input.toolFacts ?? "",
    input.draft,
    input.question,
    input.revisionInstructions,
  ]);
  if (unsupportedTokens.length > 0) {
    return {
      status: "rejected",
      revisedDraft,
      reason: "重写引入了工具事实之外的新依据",
      unsupportedTokens,
    };
  }

  if (normalize(revisedDraft) === normalize(input.draft)) {
    return { status: "no_change", revisedDraft };
  }

  return { status: "ok", revisedDraft };
}

/**
 * 找出重写里"来源里找不到"的事实型 token。
 *
 * 判定基准是"相对增量"：允许重写保留原答案里已有的说法，
 * 但不允许引入原答案与工具事实里都没有的新数字、新引文、新机构名。
 *
 * 局限：中文专有名词（承运商、门店名、人名）靠词表判断不了，
 * 这类幻觉留给重评时的 groundedness 维度兜底。
 */
export function detectUnsupportedFacts(
  revised: string,
  sources: string[],
): string[] {
  const haystack = normalize(sources.join("\n"));
  const unsupported = new Set<string>();

  for (const token of extractFactTokens(revised)) {
    const normalized = normalize(token);
    if (normalized.length === 0) continue;
    if (haystack.includes(normalized)) continue;
    unsupported.add(token);
  }

  return [...unsupported];
}

/** 从文本里抽出事实型 token。 */
export function extractFactTokens(text: string): string[] {
  const tokens: string[] = [];

  for (const match of text.matchAll(FACT_WITH_UNIT_PATTERN)) {
    tokens.push(match[0].replace(/\s+/g, ""));
  }
  for (const match of text.matchAll(QUOTED_PATTERN)) {
    const value = match[1] ?? match[2] ?? "";
    if (value.trim().length > 0) tokens.push(value.trim());
  }
  for (const match of text.matchAll(ACRONYM_PATTERN)) {
    tokens.push(match[0]);
  }
  for (const match of text.matchAll(PROPER_NOUN_PATTERN)) {
    tokens.push(match[0]);
  }
  for (const token of TIME_INFERENCE_TOKENS) {
    if (text.includes(token)) tokens.push(token);
  }

  return tokens;
}

/** 归一化：忽略大小写与空白，便于做包含判断。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 调用模型并套一层总时长上限。
 *
 * 与 Critic 用同一套口径：Promise.race + AbortController，
 * 超时后仍会把 abort 发出去，尽量让底层请求真正停下。
 */
async function callWithDeadline(
  request: { system: string; user: string },
  timeoutMs: number,
  callModel: ReviseModelCaller,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReviseTimeoutError(`模型调用超过 ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const callPromise = callModel({
    ...request,
    timeoutMs,
    signal: controller.signal,
  });
  callPromise.catch(() => undefined);

  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 拼出模型侧的 system / user 文本。
 *
 * 提示词只做两件事：落实修订要求、不许新增依据。
 * 不做任何安全判断，也不要求模型调用工具。
 */
function buildReviseRequest(
  input: ReviseInput,
  revisionInstructions: string,
  truncatedDraft: string,
): { system: string; user: string } {
  const system = [
    "你是一个答案修订器。你只输出修订后的完整答案本身，不要输出任何解释、前言、标题或代码块标记。",
    "你可以使用的信息只有三块：【用户问题】【工具事实】【原答案】，外加【修订要求】。",
    "硬性约束：",
    "1. 不得引入【工具事实】和【原答案】里都没有出现过的新事实、新数字、新名称、新依据；",
    "2. 【工具事实】不足以支撑某个说法时，删掉那个说法，不要自己补一个；",
    "3. 不要调用任何工具，也不要假装检索过；",
    "4. 逐条落实【修订要求】，但不要顺手改动与修订无关的部分；",
    "5. 保持与原答案相同的语言、格式和详略程度。",
  ].join("\n");

  const user = [
    "【用户问题】",
    input.question,
    "",
    "【工具事实】",
    input.toolFacts?.trim() || "（本次回答没有引用任何工具事实）",
    "",
    "【原答案】",
    truncatedDraft,
    "",
    "【修订要求】",
    revisionInstructions,
  ].join("\n");

  return { system, user };
}
