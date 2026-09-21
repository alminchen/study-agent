/**
 * 模型单价配置与成本估算。
 *
 * 本模块只做**估算**，不是平台真实扣款：
 *   - 单价手工维护在 MODEL_PRICING，新模型需手动加一行
 *   - 未配置的 model 走 DEFAULT_PRICING 兜底
 *   - 不考虑缓存命中、套餐价、thinking token 单独计费等
 *
 * 公式（USD）：
 *   cost = promptTokens/1M × inputPer1M + completionTokens/1M × outputPer1M
 *
 * 调用方：UsageAccumulator.estimatedCostUsd()、前端 UsagePanel 展示
 */

import type { TokenUsage } from "./types.js";

/**
 * 各模型单价：USD / 1M tokens。
 * 数值为学习 demo 估算，请以各平台官网最新价格为准。
 */
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28 },
  "gpt-5.4-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-5.6-sol": { inputPer1M: 0.2, outputPer1M: 0.8 },
};

/** 未知 model 的兜底单价（偏保守，避免低估） */
const DEFAULT_PRICING = { inputPer1M: 0.2, outputPer1M: 0.8 };

/**
 * 按模型估算单次 LLM 调用的美元成本。
 *
 * @param model - 本次调用使用的 model id（如 deepseek-chat）
 * @param usage - 该次调用的 token 用量
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  const inputCost = (usage.promptTokens / 1_000_000) * pricing.inputPer1M;
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.outputPer1M;
  return inputCost + outputCost;
}

/**
 * 合并多次 LLM 调用的 token 数（简单相加）。
 * 用于 UsageAccumulator.mergedUsage()。
 */
export function mergeUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, u) => ({
      promptTokens: acc.promptTokens + u.promptTokens,
      completionTokens: acc.completionTokens + u.completionTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  );
}

/**
 * 格式化为前端展示的美元字符串。
 * 极小值用 "<$0.000001" 避免显示 $0.000000 误导用户。
 */
export function formatCostUsd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost < 0.000001) return "<$0.000001";
  return `$${cost.toFixed(6)}`;
}
