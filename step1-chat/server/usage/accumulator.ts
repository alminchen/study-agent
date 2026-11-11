/**
 * 请求级 Token 累加器（UsageAccumulator）。
 *
 * 核心问题：用户发 1 条消息 ≠ 只调 1 次 LLM。
 *
 *   /api/chat        → ReAct 可能 askModel 3~5 次
 *   /api/chat/multi  → Supervisor + Worker(s) + Aggregate，各 1~N 次
 *   /api/rag/chat    → 0～N 次（扩写 rewriteQuery / HyDE / completeRagMessages；判空可不调回答模型）
 *   /api/chat/structured → 结构化模型流
 *
 * 用法（在 server/index.ts 每个 API 入口）：
 *
 *   const accumulator = new UsageAccumulator();
 *   const onUsage = bindUsageCallback(accumulator, "askModel", defaultModel);
 *
 *   await createChatStream({ ..., onUsage });   // complete.ts 每次 askModel 触发
 *
 *   writeUsageToStream(res, accumulator, "chat", defaultModel);  // 请求结束推 SSE + 写 store
 *
 * UsageSource 标记每次 LLM 调用来自哪一层，便于后续调试/分析（当前未暴露给前端）。
 */

import { estimateCostUsd, mergeUsage } from "./pricing.js";
import type { TokenUsage, UsageRecord, UsageSnapshot } from "./types.js";

/**
 * LLM 调用来源标签。
 * - askModel   — 单 Agent ReAct 的 askModel 节点
 * - supervisor — 多 Agent Supervisor 路由
 * - worker     — 多 Agent 各 Worker 内部 mini ReAct
 * - aggregate  — 多 Agent 汇总节点（多 Worker 时才调）
 * - rag        — 资料问答 completeRagMessages（回答模型）
 * - ragRewrite — 检索前问句扩写 rewriteQuery
 * - ragHyde    — HyDE 假文档 generateHydeDoc
 * - structured — 结构化输出 streamStructuredCompletion
 * - plan       — Plan-and-Execute 的 Planner / Executor / Re-plan / 最终回答
 * - summary    — 长上下文管理的摘要生成 summarizeDroppedMessages
 * - critic     — Reflection 的质量评分 critique
 * - revise     — Reflection 的重写 revise
 * - memory     — Memory 的事实抽取 extractMemoryFacts
 */
export type UsageSource =
  | "askModel"
  | "supervisor"
  | "worker"
  | "aggregate"
  | "rag"
  | "ragRewrite"
  | "ragHyde"
  | "structured"
  | "plan"
  | "summary"
  | "critic"
  | "revise"
  | "memory";

/**
 * 单次 HTTP 请求内的 Token 累加器。
 * 每个 API 请求创建一个实例，请求结束后 toRecord() 写入 store。
 */
export class UsageAccumulator {
  /** 每次 LLM 调用一条：记录 model、来源、用量 */
  private entries: { model: string; source: UsageSource; usage: TokenUsage }[] = [];
  /** 本轮请求携带的图片汇总（无图请求保持空） */
  private images: { count: number; totalBytes: number; estimatedTokens: number } | null = null;

  /**
   * 记录一次 LLM 调用的 usage。
   * null / undefined / totalTokens=0 时跳过（Mock、失败、空响应）。
   */
  record(model: string, source: UsageSource, usage: TokenUsage | null | undefined): void {
    if (!usage || usage.totalTokens <= 0) return;
    this.entries.push({ model, source, usage });
  }

  /**
   * 记录本轮请求携带的图片信息（count / 字节数 / 估算 token）。
   * 只记数字，不记 base64 或文件名（决策六：图片不进 usage 日志正文）。
   */
  recordImages(opts: {
    count: number;
    totalBytes: number;
    estimatedTokens: number;
  }): void {
    if (opts.count <= 0) return;
    this.images = {
      count: opts.count,
      totalBytes: opts.totalBytes,
      estimatedTokens: opts.estimatedTokens,
    };
  }

  /** 本次请求内 LLM 调用总次数 */
  get llmCalls(): number {
    return this.entries.length;
  }

  /** 是否没有任何有效 LLM 调用（Mock、检索判空不调模型等） */
  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** 把所有调用的 prompt/completion/total 相加 */
  mergedUsage(): TokenUsage {
    return mergeUsage(this.entries.map((e) => e.usage));
  }

  /**
   * 取「主模型名」：出现次数最多的 model。
   * 多 Agent 可能混用同一 model，ReAct 通常只有一个。
   * 无记录时返回 fallback（请求参数里的 defaultModel）。
   */
  primaryModel(fallback: string): string {
    if (this.entries.length === 0) return fallback;
    const counts = new Map<string, number>();
    for (const e of this.entries) {
      counts.set(e.model, (counts.get(e.model) ?? 0) + 1);
    }
    let best = fallback;
    let max = 0;
    for (const [model, count] of counts) {
      if (count > max) {
        max = count;
        best = model;
      }
    }
    return best;
  }

  /** 各次调用分别估算成本后相加（不同 model 单价可能不同） */
  estimatedCostUsd(): number {
    return this.entries.reduce((sum, e) => sum + estimateCostUsd(e.model, e.usage), 0);
  }

  /** 生成前端 SSE / JSON 用的摘要（不含 id、timestamp） */
  toSnapshot(endpoint: UsageRecord["endpoint"], fallbackModel: string): UsageSnapshot {
    const merged = this.mergedUsage();
    return {
      endpoint,
      model: this.primaryModel(fallbackModel),
      promptTokens: merged.promptTokens,
      completionTokens: merged.completionTokens,
      totalTokens: merged.totalTokens,
      llmCalls: this.llmCalls,
      estimatedCostUsd: this.estimatedCostUsd(),
      ...(this.images
        ? {
            imageCount: this.images.count,
            imageBytes: this.images.totalBytes,
            estimatedImageTokens: this.images.estimatedTokens,
          }
        : {}),
    };
  }

  /** 生成写入 store 的完整记录（含 id、timestamp） */
  toRecord(endpoint: UsageRecord["endpoint"], fallbackModel: string): UsageRecord {
    const snapshot = this.toSnapshot(endpoint, fallbackModel);
    return {
      id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      endpoint,
      model: snapshot.model,
      promptTokens: snapshot.promptTokens,
      completionTokens: snapshot.completionTokens,
      totalTokens: snapshot.totalTokens,
      llmCalls: snapshot.llmCalls,
      estimatedCostUsd: snapshot.estimatedCostUsd,
    };
  }
}

/** onUsage 回调签名：各 LLM 封装层解析到 usage 后调用 */
export type UsageCallback = (usage: TokenUsage, model: string) => void;

/**
 * 把 Accumulator 绑定成可直接传给 complete.ts / callLLM 的 onUsage 回调。
 *
 * @param accumulator - 当前请求的累加器实例
 * @param source        - 调用来源标签（askModel / supervisor / worker …）
 * @param defaultModel  - model 为空时的兜底名
 *
 * 示例：
 *   bindUsageCallback(acc, "supervisor", "deepseek-chat")
 *   → supervisorRoute / callLLM 的 onUsage 参数
 */
export function bindUsageCallback(
  accumulator: UsageAccumulator,
  source: UsageSource,
  defaultModel: string,
): UsageCallback {
  return (usage, model) => {
    accumulator.record(model || defaultModel, source, usage);
  };
}
