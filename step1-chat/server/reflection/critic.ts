/**
 * Reflection Critic 核心逻辑。
 *
 * 设计思路：
 * - 模型调用以函数参数注入（callModel），本文件不出现 fetch，单测直接注入假模型
 * - 评分失败一律走 status=error，绝不把 error 塞进 scores 字段
 * - 超时/网络错误最多重试 2 次；整次评分的耗时不超过 totalTimeoutMs
 * - 输入超长时保留首尾片段，中间用截断标记替代，避免评分成本失控
 *
 * 分层约定（与 LLM-as-Judge 严格分开）：
 * - Judge 只做安全判定，不改写内容
 * - Critic 只做质量改进，提示词、schema、阈值全部独立，不复用 Judge 的任何一份
 */
import { z } from "zod";
import {
  buildCritiqueError,
  buildCritiqueOk,
  type Critique,
  type CritiqueOk,
  type CritiqueScores,
} from "./types.js";
import { truncateMiddle } from "./text.js";

/** 一次评分调用交给模型侧的请求内容。 */
export interface CriticModelRequest {
  /** 评分 system prompt。 */
  system: string;
  /** 原问题、工具事实与待评分答案的拼接文本。 */
  user: string;
  /** 本次调用剩余的总预算；调用方应据此自行超时。 */
  timeoutMs: number;
  /** 中止信号。 */
  signal: AbortSignal;
}

/** 模型调用实现；真实实现放 fetch，测试里换成假模型即可。 */
export type CriticModelCaller = (request: CriticModelRequest) => Promise<string>;

/** 评分过程的元信息，不参与评分结论。 */
export interface CriticMeta {
  /** 原文本长度。 */
  originalChars: number;
  /** 实际送入模型的文本长度。 */
  sentChars: number;
  /** 是否发生截断。 */
  truncated: boolean;
  /** 实际尝试次数（含首次）。 */
  attempts: number;
  /** 评分总耗时。 */
  durationMs: number;
}

/** Critic 的调用参数。 */
export interface CriticOptions {
  /** 必填：模型调用入口。 */
  callModel: CriticModelCaller;
  /** 送入评分的文本上限；超出则保留首尾片段。默认 8000。 */
  maxInputChars?: number;
  /** 整次评分（含重试）的耗时上限，默认 10000ms。 */
  totalTimeoutMs?: number;
  /** 最多重试次数，默认 2。 */
  maxRetries?: number;
  /** 评分过程元信息回调，用于写 trace。 */
  onMeta?: (meta: CriticMeta) => void;
}

/** 待评分的内容。 */
export interface CritiqueInput {
  /** 用户原始问题。 */
  question: string;
  /** 已生成的最终答案。 */
  draft: string;
  /** 工具返回的事实；重写只能引用这里出现过的内容。 */
  toolFacts?: string;
}

/**
 * 首版重写阈值。
 *
 * 任一维度 <= 3 表示答案有明显短板；出现 groundedness 问题表示答案可能
 * 掺入了工具事实之外的内容——即使分数不低也值得重写。
 */
export const REFLECTION_REWRITE_THRESHOLD = 3;

/** 模型允许输出的字段；status 与 schemaVersion 由本文件补齐。 */
const CritiqueModelOutputSchema = z.object({
  scores: z.object({
    relevance: z.number().int().min(1).max(5),
    completeness: z.number().int().min(1).max(5),
    groundedness: z.number().int().min(1).max(5),
    clarity: z.number().int().min(1).max(5),
  }),
  issues: z
    .array(
      z.object({
        dimension: z.enum(["relevance", "completeness", "groundedness", "clarity"]),
        detail: z.string().min(1).max(200),
      }),
    )
    .max(10),
  shouldRewrite: z.boolean(),
  revisionInstructions: z.string().max(2_000),
  reason: z.string().min(1).max(500),
});

/** 超时错误；与业务错误区分，便于判断是否值得重试。 */
class CriticTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticTimeoutError";
  }
}

/** JSON 解析失败与 schema 校验失败；两者都带原始片段。 */
class CriticParseError extends Error {
  constructor(
    readonly kind: "bad_json" | "schema_error",
    readonly raw: string,
    message: string,
  ) {
    super(message);
    this.name = "CriticParseError";
  }
}

/**
 * 对最终答案做一次质量评分。
 *
 * 顺序固定：截断 → 拼提示词 → 调用 → 解析 JSON → schema 校验 → 构造结果。
 * 每一步的失败都收敛成 errorKind，不向外抛异常，也绝不返回伪造的分数。
 */
export async function critique(
  input: CritiqueInput,
  options: CriticOptions,
): Promise<Critique> {
  const startedAt = Date.now();
  const maxInputChars = options.maxInputChars ?? 8_000;
  const totalTimeoutMs = options.totalTimeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 2;

  // 只截断答案：问题和工具事实是评分的依据，砍掉会让分数失去意义。
  const truncated = truncateMiddle(input.draft, maxInputChars);
  const request = buildCriticRequest(input, truncated.text);

  let attempts = 0;
  let lastError: { kind: "timeout" | "api_error"; message: string } = {
    kind: "api_error",
    message: "评分未开始",
  };

  const emitMeta = (): void => {
    options.onMeta?.({
      originalChars: input.draft.length + input.question.length,
      sentChars: truncated.text.length,
      truncated: truncated.truncated,
      attempts,
      durationMs: Date.now() - startedAt,
    });
  };

  // 每次失败先看预算是否还够；够则重试，不够直接按超时结束。
  while (attempts <= maxRetries) {
    const remaining = totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      lastError = { kind: "timeout", message: "评分总时长已耗尽" };
      break;
    }

    attempts += 1;
    try {
      const raw = await callWithDeadline(request, remaining, options.callModel);
      const parsed = parseModelOutput(raw);
      const result = buildCritiqueOk(parsed);
      emitMeta();
      return result;
    } catch (error) {
      if (error instanceof CriticTimeoutError) {
        lastError = { kind: "timeout", message: error.message };
        continue;
      }
      // 解析与校验失败重试也不会变好，直接收敛成 error 返回。
      if (error instanceof CriticParseError) {
        emitMeta();
        return buildCritiqueError(error.kind, {
          retries: attempts - 1,
          raw: error.raw,
          message: error.message,
        });
      }
      lastError = {
        kind: "api_error",
        message: error instanceof Error ? error.message : "模型调用失败",
      };
    }
  }

  emitMeta();
  return buildCritiqueError(lastError.kind, {
    retries: Math.max(0, attempts - 1),
    message: lastError.message,
  });
}

/**
 * 按首版阈值判断是否值得重写。
 *
 * 只在评分成功时有意义；评分失败一律返回 false（不重写）。
 * 判定规则：任一维度 <= 3，或 issues 里存在 groundedness 问题。
 * 模型给出的 shouldRewrite 只是参考，最终以本函数为准，避免模型
 * 自说自话地要求重写。
 */
export function shouldRewriteByThreshold(
  critique: Critique,
  threshold: number = REFLECTION_REWRITE_THRESHOLD,
): boolean {
  if (critique.status !== "ok") return false;

  const scores = critique.scores;
  const hasLowScore = Object.values(scores).some((score) => score <= threshold);
  const hasGroundednessIssue = critique.issues.some(
    (issue) => issue.dimension === "groundedness",
  );
  return hasLowScore || hasGroundednessIssue;
}

/** 四项分数的平均值；用于 A/B 对比中的质量指标。 */
export function averageScore(scores: CritiqueScores): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return values.reduce((sum, score) => sum + score, 0) / values.length;
}

/**
 * 调用模型并套一层总时长上限。
 *
 * 超时用 Promise.race 实现，不依赖模型实现自己处理 signal；
 * 超时后仍会把 abort 发出去，尽量让底层请求真正停下。
 */
async function callWithDeadline(
  request: { system: string; user: string },
  timeoutMs: number,
  callModel: CriticModelCaller,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CriticTimeoutError(`模型调用超过 ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const callPromise = callModel({
    ...request,
    timeoutMs,
    signal: controller.signal,
  });
  // race 失败后底层 Promise 仍可能 reject，这里提前挂一个空处理避免未捕获异常。
  callPromise.catch(() => undefined);

  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从模型返回里取出 JSON 对象；兼容 ```json 包裹。 */
function parseModelOutput(raw: string): Omit<CritiqueOk, "status" | "schemaVersion"> {
  const text = raw.trim();
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  const jsonText =
    start >= 0 && end > start ? withoutFence.slice(start, end + 1) : withoutFence;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new CriticParseError("bad_json", raw, "模型返回不是合法 JSON");
  }

  const checked = CritiqueModelOutputSchema.safeParse(parsed);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new CriticParseError(
      "schema_error",
      raw,
      `模型返回未通过 schema 校验：${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
    );
  }
  // 建议重写却不给修订指令，模型输出本身就是不合契约的，按 schema 错误处理。
  if (checked.data.shouldRewrite && checked.data.revisionInstructions.trim() === "") {
    throw new CriticParseError(
      "schema_error",
      raw,
      "建议重写时必须给出 revisionInstructions",
    );
  }
  return checked.data;
}

/**
 * 拼出模型侧的 system / user 文本。
 *
 * 提示词只描述"按固定 rubric 给最终答案打分"这一件事：
 * - 不提工具执行是否正确，那是工具层的事
 * - 不做任何安全判断，那是 Judge 的事
 * - 明确要求只依据给定的事实，指出无依据的断言属于 groundedness 问题
 */
function buildCriticRequest(
  input: CritiqueInput,
  truncatedDraft: string,
): { system: string; user: string } {
  const system = [
    "你是一个严格的质量评审器，只输出一个 JSON 对象，不要输出任何解释或代码块标记。",
    "你的任务是按固定 rubric 给下面这份【最终答案】打分，只评估答案质量，不评判工具执行是否正确。",
    "JSON 字段固定为：scores、issues、shouldRewrite、revisionInstructions、reason。",
    "scores 固定四项，每项是 1 到 5 的整数：",
    "  relevance：答案是否正面回应了用户问题；",
    "  completeness：答案是否覆盖了问题中的全部子项；",
    "  groundedness：答案中的每个事实性结论是否都能在【工具事实】里找到依据；",
    "  clarity：答案是否组织清晰、易读。",
    "issues 是数组，每项形如 {\"dimension\":\"completeness\",\"detail\":\"具体问题\"}，",
    "dimension 只能是 relevance、completeness、groundedness、clarity 之一；没问题就输出空数组。",
    "shouldRewrite 是布尔值，表示你是否建议重写。",
    "revisionInstructions 是不超过 2000 字的具体修改要求；shouldRewrite 为 true 时不能为空。",
    "reason 是不超过 500 字的一句话理由。",
    "不要输出 rubric 之外的字段，不要给出总分或加权分。",
  ].join("\n");

  const user = [
    "【用户问题】",
    input.question,
    "",
    "【工具事实】",
    input.toolFacts?.trim() || "（本次回答没有引用任何工具事实）",
    "",
    "【待评分的最终答案】",
    truncatedDraft,
  ].join("\n");

  return { system, user };
}
