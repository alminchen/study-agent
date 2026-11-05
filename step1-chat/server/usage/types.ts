/**
 * Token / 成本模块的类型定义。
 *
 * 数据分层：
 *   TokenUsage     — 单次 LLM 调用的原始用量（来自 API usage 字段）
 *   UsageSnapshot  — 一次 HTTP 请求合并后的摘要（推给前端 SSE / JSON）
 *   UsageRecord    — 写入 store 的持久化记录（含 id、timestamp）
 *   UsageSummary   — GET /api/usage 返回的全局汇总
 *
 * 学习计划：stage5-token-cost-learning-plan.md
 */

/** 单次 LLM 调用的 token 用量（OpenAI 兼容 usage 字段） */
export interface TokenUsage {
  /** 输入 token 数（system + 历史 + 工具回填） */
  promptTokens: number;
  /** 模型生成的输出 token 数 */
  completionTokens: number;
  /** prompt + completion 之和（API 通常直接返回） */
  totalTokens: number;
}

/**
 * 写入 store 的一条请求级记录。
 * 一次用户提问（一条 HTTP 请求）对应一条 UsageRecord，
 * 即使内部调了多次 LLM（ReAct 多轮 / 多 Agent），也合并为一条。
 */
export interface UsageRecord {
  /** 唯一 id，格式 usage_{timestamp}_{random} */
  id: string;
  /** 记录写入时间（Unix ms） */
  timestamp: number;
  /** 来自哪条 API 链路 */
  endpoint: "chat" | "chat/multi" | "rag/chat" | "chat/structured" | "chat/plan";
  /** 主模型名（出现次数最多的 model；无调用时用请求默认值） */
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 本次请求内 LLM 调用次数（ReAct 3 轮 = 3，多 Agent 可能 5+） */
  llmCalls: number;
  /** 按 MODEL_PRICING 估算的美元成本（非平台真实账单） */
  estimatedCostUsd: number;
}

/** GET /api/usage 返回的全局汇总结构 */
export interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  /** 按 endpoint 分组：chat / chat/multi / rag/chat / chat/structured / chat/plan */
  byEndpoint: Record<string, { requests: number; totalTokens: number; costUsd: number }>;
  /** 按 model 分组：便于对比不同模型成本 */
  byModel: Record<string, { requests: number; totalTokens: number; costUsd: number }>;
  /** 最近 N 条原始记录（默认 50），按时间倒序 */
  recent: UsageRecord[];
}

/**
 * SSE / JSON 返回给前端的单次请求用量摘要。
 * 与 UsageRecord 字段相近，但不含 id / timestamp（前端展示用）。
 */
export interface UsageSnapshot {
  /** 来自哪条 API（toSnapshot 调用方必传，不为 optional） */
  endpoint: UsageRecord["endpoint"];
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  estimatedCostUsd: number;
}
