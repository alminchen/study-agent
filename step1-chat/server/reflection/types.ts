/**
 * Reflection 的评分契约。
 *
 * 设计思路：
 * - 评分成功与失败是两条互斥路径，用 status 做判别式联合，调用方一句即可分流
 * - 失败不带任何分数字段——失败不是"0 分"，把它记成分数会污染指标分母
 * - rubric 固定为四项 1~5 分，维度不可增减，保证不同批次评分可比
 * - 所有文本字段都有上限，防止模型输出超长内容拖垮重写链路
 */
import { z } from "zod";

/** 首版 Reflection 协议版本；字段语义变化时升级。 */
export const REFLECTION_SCHEMA_VERSION = "reflection.v1" as const;

/** Reflection 输出的规模上限；超长内容一律截断而不是直接拒绝。 */
export const REFLECTION_LIMITS = {
  /** issues 的最大条数。 */
  issuesMaxItems: 10,
  /** 单条 issue 的字符上限。 */
  issueDetailMaxChars: 200,
  /** revisionInstructions 的字符上限。 */
  revisionInstructionsMaxChars: 2_000,
  /** reason 的字符上限。 */
  reasonMaxChars: 500,
  /** 失败时保留的原始响应字符上限。 */
  rawMaxChars: 500,
  /** 失败描述的字符上限。 */
  errorMessageMaxChars: 200,
} as const;

/**
 * rubric 的四个固定维度。
 *
 * 只针对最终答案的质量，不涉及工具执行正确性——那是工具层的事。
 */
export const ReflectionDimensionSchema = z.enum([
  "relevance",
  "completeness",
  "groundedness",
  "clarity",
]);
export type ReflectionDimension = z.infer<typeof ReflectionDimensionSchema>;

/** 单维分数：1~5 的整数。 */
const scoreSchema = z.number().int().min(1).max(5);

/** 四项分数一一对应，不接受缺项。 */
export const CritiqueScoresSchema = z
  .object({
    relevance: scoreSchema,
    completeness: scoreSchema,
    groundedness: scoreSchema,
    clarity: scoreSchema,
  })
  .strict();
export type CritiqueScores = z.infer<typeof CritiqueScoresSchema>;

/** 单条问题：标明属于哪个维度，便于按维度做阈值判断。 */
export const CritiqueIssueSchema = z
  .object({
    dimension: ReflectionDimensionSchema,
    detail: z.string().min(1).max(REFLECTION_LIMITS.issueDetailMaxChars),
  })
  .strict();
export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>;

/** 评分成功：模型给出了可用结论。 */
export const CritiqueOkSchema = z
  .object({
    status: z.literal("ok"),
    schemaVersion: z.literal(REFLECTION_SCHEMA_VERSION),
    /** 四项 rubric 分数。 */
    scores: CritiqueScoresSchema,
    /** 发现的问题清单；为空表示没看出明显问题。 */
    issues: z
      .array(CritiqueIssueSchema)
      .max(REFLECTION_LIMITS.issuesMaxItems),
    /** 是否建议重写；最终是否真重写由阈值规则决定。 */
    shouldRewrite: z.boolean(),
    /** 给重写模型的修订指令；shouldRewrite 为 true 时不允许为空。 */
    revisionInstructions: z.string().max(
      REFLECTION_LIMITS.revisionInstructionsMaxChars,
    ),
    /** 一句话理由，只给人看，不参与逻辑判断。 */
    reason: z.string().min(1).max(REFLECTION_LIMITS.reasonMaxChars),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.shouldRewrite && result.revisionInstructions.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["revisionInstructions"],
        message: "建议重写时必须给出 revisionInstructions",
      });
    }
  });
export type CritiqueOk = z.infer<typeof CritiqueOkSchema>;

/** 失败种类：调用层把各种异常收敛到这四个语义。 */
export const ReflectionErrorKindSchema = z.enum([
  "timeout",
  "bad_json",
  "api_error",
  "schema_error",
]);
export type ReflectionErrorKind = z.infer<typeof ReflectionErrorKindSchema>;

/**
 * 评分失败：没有可用结论。
 *
 * 注意这里没有 scores 字段——失败不是"低分"，把它记成分数会污染
 * Evals 的质量均值，也会让"是否重写"的判断失去依据。
 */
export const CritiqueErrorSchema = z
  .object({
    status: z.literal("error"),
    schemaVersion: z.literal(REFLECTION_SCHEMA_VERSION),
    /** 失败类别，决定是否重试以及是否计入错误率。 */
    errorKind: ReflectionErrorKindSchema,
    /** 已经重试的次数；0 表示首次就失败。 */
    retries: z.number().int().nonnegative(),
    /** 原始响应片段（已截断），用于排查模型输出问题。 */
    raw: z.string().max(REFLECTION_LIMITS.rawMaxChars),
    /** 可读错误描述，只用于日志与报告。 */
    message: z.string().max(REFLECTION_LIMITS.errorMessageMaxChars).optional(),
  })
  .strict();
export type CritiqueError = z.infer<typeof CritiqueErrorSchema>;

/** 完整评分结果：成功与失败两条路径的统一入口。 */
export const CritiqueSchema = z.discriminatedUnion("status", [
  CritiqueOkSchema,
  CritiqueErrorSchema,
]);
export type Critique = z.infer<typeof CritiqueSchema>;

/** 评分成功——调用方用它区分"有结论"和"没结论"。 */
export function isCritiqueOk(result: Critique): result is CritiqueOk {
  return result.status === "ok";
}

/** 评分失败——与 isCritiqueOk 互为补集。 */
export function isCritiqueError(result: Critique): result is CritiqueError {
  return result.status === "error";
}

/** 截断原始响应，避免把超长模型输出整段塞进结果里。 */
export function truncateCritiqueRaw(
  raw: string,
  maxChars: number = REFLECTION_LIMITS.rawMaxChars,
): string {
  if (raw.length <= maxChars) return raw;
  const suffix = "…[truncated]";
  const keep = Math.max(0, maxChars - suffix.length);
  return `${raw.slice(0, keep)}${suffix}`;
}

/** 构造失败结果；raw 统一截断，retries 不允许负数。 */
export function buildCritiqueError(
  errorKind: ReflectionErrorKind,
  options: {
    retries?: number;
    raw?: string;
    message?: string;
  } = {},
): CritiqueError {
  return CritiqueErrorSchema.parse({
    status: "error",
    schemaVersion: REFLECTION_SCHEMA_VERSION,
    errorKind,
    retries: Math.max(0, Math.trunc(options.retries ?? 0)),
    raw: truncateCritiqueRaw(options.raw ?? ""),
    message: options.message
      ? options.message.slice(0, REFLECTION_LIMITS.errorMessageMaxChars)
      : undefined,
  });
}

/** 构造成功结果；分数越界会直接抛错，不做静默修正。 */
export function buildCritiqueOk(
  result: Omit<CritiqueOk, "status" | "schemaVersion">,
): CritiqueOk {
  return CritiqueOkSchema.parse({
    status: "ok",
    schemaVersion: REFLECTION_SCHEMA_VERSION,
    ...result,
  });
}
