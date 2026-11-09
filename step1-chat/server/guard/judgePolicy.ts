/**
 * Judge 决策表：把「正则 Guard 结论 + Judge 结论」映射成「放行 / 拦截 / 打标」。
 *
 * 纯函数：不发请求、不读配置、不打日志。
 * 这样同一份口径可以被三处复用：
 * - 运行时（judgeRuntime.ts）做真实拦截决策
 * - 离线评测（scripts/run-judge-evals.ts）模拟 enforce 会拦掉什么
 * - 单测直接构造组合，不需要 mock 模型
 *
 * 决策表见阶段 6 计划文档第 5 节，核心原则三条：
 * 1. 规则优先：正则 Guard 已命中的样本维持原有行为，Judge 只补证据，不改判。
 * 2. 置信度闸门：置信度低于阈值的高/中风险一律降级为「放行 + 打标」。
 * 3. 永不因故障拦截：Judge 判定失败（status=error）一律回退正则决策并放行。
 */
import type { JudgeMode } from "../runtimeConfig.js";
import type { RiskLevel } from "./inputGuard.js";
import type { JudgeResult } from "./judgeSchema.js";
import { REPLACEMENT } from "./outputGuard.js";

/**
 * 判定对象。
 * - input：用户输入（chat / chatMulti / ragChat 的问题）
 * - retrieval：进入 prompt 的检索片段（间接注入入口）
 * - output：模型输出（由输出侧决策函数处理，不走这里）
 */
export type JudgeSurface = "input" | "retrieval";

/** 决策标签：同一动作下的细分原因，写进 trace 便于统计。 */
export type JudgeDecisionLabel =
  /** 正则 Guard 已命中，维持原有标记行为。 */
  | "guard_hit"
  /** Judge 判定为高风险且置信度达标，输入被拦截。 */
  | "judge_high_blocked"
  /** Judge 判定为中风险，只打标放行。 */
  | "judge_medium"
  /** Judge 与正则结论不一致，或置信度不足，只能打标。 */
  | "judge_disagree"
  /** Judge 判定失败，已回退正则决策。 */
  | "judge_error";

/** 输入侧的决策结果。 */
export interface InputJudgeDecision {
  /** allow 放行；block 拦截（不再调用模型）。 */
  action: "allow" | "block";
  /** 细分标签，便于离线统计各分支命中量。 */
  label?: JudgeDecisionLabel;
  /** 人可读的原因，写进 trace 与日志。 */
  reason?: string;
  /** Judge 结论与正则结论是否不一致。 */
  disagree: boolean;
}

/** 输出侧的决策结果。 */
export interface OutputJudgeDecision {
  /** allow 不处理；flag 建议按泄露处理（但不自动替换主回答）。 */
  action: "allow" | "flag";
  /** 是否建议按「泄露」处理。 */
  leaked: boolean;
  label?: JudgeDecisionLabel;
  reason?: string;
  /** 建议的替换文本；只作为建议交给调用方。 */
  suggestedSafeText?: string;
}

/** 输入被拦截时返回给用户的安全文案。 */
export const SAFE_BLOCK_TEXT =
  "抱歉，我无法处理这条请求。如果这是误操作，可以换个说法再试一次。";

/**
 * 输入侧决策。
 *
 * 行序即优先级，越靠前越先命中。
 */
export function decideInputAction(params: {
  mode: JudgeMode;
  guard: { level: RiskLevel; rules: string[] };
  judge: JudgeResult;
  confidenceThreshold: number;
  /** 判定对象，默认 input。 */
  surface?: JudgeSurface;
}): InputJudgeDecision {
  const { mode, guard, judge, confidenceThreshold, surface = "input" } = params;

  // off / shadow 都不参与拦截决策：off 不调用模型，shadow 只记录不改行为。
  if (mode !== "enforce") {
    return { action: "allow", disagree: false };
  }

  // 检索片段走另一张表：它此前没有任何保护，命中即拦，语义与用户输入不同。
  if (surface === "retrieval") {
    return decideRetrievalAction({ guard, judge, confidenceThreshold });
  }

  // ---- 行 1：正则已命中 → 维持正则现状，Judge 只补证据 ----
  if (guard.level !== "none") {
    return {
      action: "allow",
      label: "guard_hit",
      disagree: judge.status === "ok" && judge.risk === "none",
      reason: `正则 Guard 已命中 ${guard.level}，维持原有标记行为`,
    };
  }

  // ---- 行 6：Judge 故障 → 回退正则决策（放行），永不因 Judge 故障拦正常用户 ----
  if (judge.status === "error") {
    return {
      action: "allow",
      label: "judge_error",
      disagree: false,
      reason: `Judge 判定失败（${judge.errorKind ?? "unknown"}），回退正则决策`,
    };
  }

  const risk = judge.risk;
  const confidence = judge.confidence;
  const belowThreshold = confidence < confidenceThreshold;

  // ---- 行 2：high 且置信度达标 → 拦截（Judge 的主要价值场景）----
  if (risk === "high") {
    if (belowThreshold) {
      return {
        action: "allow",
        label: "judge_disagree",
        disagree: true,
        reason: `高风险但置信度 ${confidence} 低于阈值 ${confidenceThreshold}，降级放行`,
      };
    }
    return {
      action: "block",
      label: "judge_high_blocked",
      disagree: true,
      reason: judge.shortReason,
    };
  }

  // ---- 行 3：medium → 只打标放行 ----
  if (risk === "medium") {
    return {
      action: "allow",
      label: belowThreshold ? "judge_disagree" : "judge_medium",
      disagree: true,
      reason: judge.shortReason,
    };
  }

  // ---- 行 4/5：none → 放行；置信度不足时额外打分歧标签 ----
  if (belowThreshold) {
    return {
      action: "allow",
      label: "judge_disagree",
      disagree: true,
      reason: "Judge 未发现风险，但置信度低于阈值",
    };
  }
  return { action: "allow", disagree: false };
}

/**
 * 检索片段（进入 prompt 的资料）的决策。
 *
 * 与用户输入最大的不同：
 * - 用户输入这条链路原本就有正则「只标记不拦截」，规则优先是为了维持现状；
 * - 检索片段这条链路此前完全没有保护——文档里写「忽略之前的指令」，
 *   模型会照做，这是典型的间接注入，所以高危命中直接拦。
 *
 * 其余分支与输入侧一致：Judge 故障放行、置信度不足降级打标、medium 只打标。
 */
function decideRetrievalAction(params: {
  guard: { level: RiskLevel; rules: string[] };
  judge: JudgeResult;
  confidenceThreshold: number;
}): InputJudgeDecision {
  const { guard, judge, confidenceThreshold } = params;

  // ---- 行 1：正则高危命中 → 直接拦截（这层此前无保护）----
  if (guard.level === "high") {
    return {
      action: "block",
      label: "guard_hit",
      disagree: judge.status === "ok" && judge.risk === "none",
      reason: `检索片段命中注入规则（${guard.rules.join(", ") || "high"}），已拦截`,
    };
  }

  // ---- 行 2：正则中危命中 → 只打标放行 ----
  if (guard.level === "medium") {
    return {
      action: "allow",
      label: "guard_hit",
      disagree: judge.status === "ok" && judge.risk === "none",
      reason: `检索片段命中可疑规则（${guard.rules.join(", ")}），仅打标`,
    };
  }

  // ---- 行 3：Judge 故障 → 放行，绝不因故障中断检索 ----
  if (judge.status === "error") {
    return {
      action: "allow",
      label: "judge_error",
      disagree: false,
      reason: `Judge 判定失败（${judge.errorKind ?? "unknown"}），回退正则决策`,
    };
  }

  const risk = judge.risk;
  const confidence = judge.confidence;
  const belowThreshold = confidence < confidenceThreshold;

  // ---- 行 4：high 且置信度达标 → 拦截 ----
  if (risk === "high") {
    if (belowThreshold) {
      return {
        action: "allow",
        label: "judge_disagree",
        disagree: true,
        reason: `检索片段高风险但置信度 ${confidence} 低于阈值 ${confidenceThreshold}，降级放行`,
      };
    }
    return {
      action: "block",
      label: "judge_high_blocked",
      disagree: true,
      reason: judge.shortReason,
    };
  }

  // ---- 行 5：medium → 只打标放行 ----
  if (risk === "medium") {
    return {
      action: "allow",
      label: belowThreshold ? "judge_disagree" : "judge_medium",
      disagree: true,
      reason: judge.shortReason,
    };
  }

  // ---- 行 6：none → 放行；置信度不足时打分歧标签 ----
  if (belowThreshold) {
    return {
      action: "allow",
      label: "judge_disagree",
      disagree: true,
      reason: "Judge 未发现风险，但置信度低于阈值",
    };
  }
  return { action: "allow", disagree: false };
}

/**
 * 输出侧决策。
 *
 * 与输入侧最大的不同：这里不产生「拦截主回答」的动作，
 * 只给出「建议按泄露处理 + 建议替换文本」，由调用方决定是否替换。
 */
export function decideOutputAction(params: {
  mode: JudgeMode;
  judge: JudgeResult;
  confidenceThreshold: number;
  /** 正则 OutputGuard 是否已判定泄露。 */
  regexLeaked: boolean;
  /** 正则 OutputGuard 命中时的替换文案。 */
  regexSafeText?: string;
}): OutputJudgeDecision {
  const { mode, judge, confidenceThreshold, regexLeaked, regexSafeText } = params;

  if (mode !== "enforce") {
    return { action: "allow", leaked: regexLeaked };
  }

  if (judge.status === "error") {
    return {
      action: "allow",
      leaked: regexLeaked,
      label: "judge_error",
      reason: `Judge 判定失败（${judge.errorKind ?? "unknown"}），回退正则决策`,
    };
  }

  const risk = judge.risk;
  const confidence = judge.confidence;
  const belowThreshold = confidence < confidenceThreshold;

  // 正则已判定泄露：Judge 的结论只作为补充证据，不改变既有处理。
  if (regexLeaked) {
    return {
      action: "flag",
      leaked: true,
      reason: "正则 OutputGuard 已判定泄露，Judge 结论仅作补充",
      suggestedSafeText: regexSafeText,
    };
  }

  if (risk === "high" && !belowThreshold) {
    return {
      action: "flag",
      leaked: true,
      label: "judge_high_blocked",
      reason: judge.shortReason,
      // 正则没命中时没有 safeText 可用，退回 OutputGuard 的统一口径文案。
      suggestedSafeText: regexSafeText ?? REPLACEMENT,
    };
  }

  if (risk === "medium" && !belowThreshold) {
    return {
      action: "flag",
      leaked: false,
      label: "judge_medium",
      reason: judge.shortReason,
    };
  }

  if (belowThreshold) {
    return {
      action: "allow",
      leaked: false,
      label: "judge_disagree",
      reason: "Judge 置信度低于阈值，不作为结论",
    };
  }

  return { action: "allow", leaked: false };
}
