/**
 * LLM-as-Judge 的结构化输出契约。
 *
 * 设计思路：
 * - 成功与失败是两条互斥的路径，用 status 做判别式联合，调用方一句即可分流
 * - 失败绝不写进 risk 字段——risk 只表达"模型认为内容有多危险"，不表达"这次调用失败"
 * - 不收长推理过程，只要结构化结论：等级、置信度、类别、理由、命中规则
 * - 所有字段都有上限，防止模型输出超长文本拖垮判定链路
 */
import { z } from "zod";
import type { RiskLevel } from "./inputGuard.js";

/** 首版 Judge 协议版本；字段语义变化时升级。 */
export const JUDGE_SCHEMA_VERSION = 1 as const;

/** Judge 输出的规模上限；超长内容一律截断而不是直接拒绝。 */
export const JUDGE_LIMITS = {
  /** shortReason 的字符上限。 */
  shortReasonMaxChars: 200,
  /** categories 的最大条数。 */
  categoriesMaxItems: 5,
  /** 单个 category 的字符上限。 */
  categoryMaxChars: 50,
  /** matchedRules 的最大条数。 */
  matchedRulesMaxItems: 10,
  /** 单个规则 ID 的字符上限。 */
  matchedRuleMaxChars: 50,
  /** 失败时保留的原始响应字符上限。 */
  rawMaxChars: 500,
  /** 失败描述的字符上限。 */
  errorMessageMaxChars: 200,
} as const;

/** Judge 给出的风险等级，与 Guard 的 RiskLevel 保持同一口径。 */
export const JudgeRiskSchema = z.enum(["none", "medium", "high"]);
export type JudgeRisk = z.infer<typeof JudgeRiskSchema>;

/**
 * 编译期断言：Judge 的风险枚举必须与 Guard 的 RiskLevel 完全等价。
 *
 * 一旦两边漂移（例如 Guard 新增 critical），该类型会退化成 never，
 * 这行赋值随之报错，避免两套等级在业务层被混用。
 */
export type JudgeRiskMatchesGuardRisk = JudgeRisk extends RiskLevel
  ? RiskLevel extends JudgeRisk
    ? true
    : never
  : never;
export const JUDGE_RISK_MATCHES_GUARD: JudgeRiskMatchesGuardRisk = true;

/** 失败种类：调用层把各种异常收敛到这四个语义。 */
export const JudgeErrorKindSchema = z.enum([
  "timeout",
  "bad_json",
  "api_error",
  "schema_error",
]);
export type JudgeErrorKind = z.infer<typeof JudgeErrorKindSchema>;

/** 判定成功：模型给出了可用结论。 */
export const JudgeOkSchema = z
  .object({
    status: z.literal("ok"),
    schemaVersion: z.literal(JUDGE_SCHEMA_VERSION),
    /** 内容风险等级；与 Guard 同口径，none 表示放行。 */
    risk: JudgeRiskSchema,
    /** 模型自评置信度，0~1；低于阈值时业务层会降级为"放行+打标"。 */
    confidence: z.number().min(0).max(1),
    /** 命中的风险类别，用于分组统计与人工复核。 */
    categories: z
      .array(
        z.string().min(1).max(JUDGE_LIMITS.categoryMaxChars),
      )
      .max(JUDGE_LIMITS.categoriesMaxItems),
    /** 一句话理由，只给人看，不参与逻辑判断。 */
    shortReason: z.string().min(1).max(JUDGE_LIMITS.shortReasonMaxChars),
    /** 模型判断命中的规则 ID，可与正则 Guard 的 matchedRules 对照。 */
    matchedRules: z
      .array(z.string().min(1).max(JUDGE_LIMITS.matchedRuleMaxChars))
      .max(JUDGE_LIMITS.matchedRulesMaxItems),
  })
  .strict();

export type JudgeOkResult = z.infer<typeof JudgeOkSchema>;

/**
 * 判定失败：没有可用结论。
 *
 * 注意这里没有 risk 字段——失败不是"低风险"，也不是"高风险"，
 * 把它记成任何等级都会污染指标分母。
 */
export const JudgeErrorSchema = z
  .object({
    status: z.literal("error"),
    schemaVersion: z.literal(JUDGE_SCHEMA_VERSION),
    /** 失败类别，决定是否重试以及是否计入错误率。 */
    errorKind: JudgeErrorKindSchema,
    /** 已经重试的次数；0 表示首次就失败。 */
    retries: z.number().int().nonnegative(),
    /** 原始响应片段（已截断），用于排查模型输出问题。 */
    raw: z.string().max(JUDGE_LIMITS.rawMaxChars),
    /** 可读错误描述，只用于日志与报告。 */
    message: z.string().max(JUDGE_LIMITS.errorMessageMaxChars).optional(),
  })
  .strict();

export type JudgeErrorResult = z.infer<typeof JudgeErrorSchema>;

/** Judge 完整结果：成功与失败两条路径的统一入口。 */
export const JudgeSchema = z.discriminatedUnion("status", [
  JudgeOkSchema,
  JudgeErrorSchema,
]);

export type JudgeResult = z.infer<typeof JudgeSchema>;

/** 判定成功——调用方用它区分"有结论"和"没结论"。 */
export function isJudgeOk(result: JudgeResult): result is JudgeOkResult {
  return result.status === "ok";
}

/** 判定失败——与 isJudgeOk 互为补集。 */
export function isJudgeError(result: JudgeResult): result is JudgeErrorResult {
  return result.status === "error";
}

/**
 * 取风险等级；失败时返回 null。
 *
 * 业务层需要"一个等级"时用这个，避免到处写 if (status === "ok")。
 */
export function judgeRiskOf(result: JudgeResult): JudgeRisk | null {
  return isJudgeOk(result) ? result.risk : null;
}

/** 截断原始响应，避免把超长模型输出整段塞进结果里。 */
export function truncateJudgeRaw(
  raw: string,
  maxChars: number = JUDGE_LIMITS.rawMaxChars,
): string {
  if (raw.length <= maxChars) return raw;
  // 截断标记本身也占长度，先留出它的位置，保证结果不超过上限。
  const suffix = "…[truncated]";
  const keep = Math.max(0, maxChars - suffix.length);
  return `${raw.slice(0, keep)}${suffix}`;
}

/** 构造失败结果；raw 统一截断，retries 不允许负数。 */
export function buildJudgeError(
  errorKind: JudgeErrorKind,
  options: {
    retries?: number;
    raw?: string;
    message?: string;
  } = {},
): JudgeErrorResult {
  return JudgeErrorSchema.parse({
    status: "error",
    schemaVersion: JUDGE_SCHEMA_VERSION,
    errorKind,
    retries: Math.max(0, Math.trunc(options.retries ?? 0)),
    raw: truncateJudgeRaw(options.raw ?? ""),
    message: options.message
      ? options.message.slice(0, JUDGE_LIMITS.errorMessageMaxChars)
      : undefined,
  });
}

/** 构造成功结果；置信度越界会直接抛错，不做静默修正。 */
export function buildJudgeOk(
  result: Omit<JudgeOkResult, "status" | "schemaVersion">,
): JudgeOkResult {
  return JudgeOkSchema.parse({
    status: "ok",
    schemaVersion: JUDGE_SCHEMA_VERSION,
    ...result,
  });
}
