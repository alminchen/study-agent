/**
 * Aggregate（汇总节点）— 多 Agent 编排的最后一个环节。
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 职责                                                             │
 * │ 接收所有 Worker 的执行结果，整合成一段连贯的最终回复给用户。     │
 * │                                                                 │
 * │ 不是简单拼接！而是让模型理解多个来源的信息后，                   │
 * │ 用自然语言组织成一段流畅的回答。                                 │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 数据流位置：
 *
 *   Worker1.output ─┐
 *   Worker2.output ─┼──► aggregate() ──► 最终回复给用户
 *   Worker3.output ─┘
 *
 * 优化策略：
 * - 只有 1 个 Worker 且成功 → 直接透传其 output，不浪费一次 LLM 调用
 * - 多个 Worker → 调一次 LLM 汇总
 * - 有 Worker 出错 → 汇总时告知用户"部分信息获取失败"
 *
 * 为什么需要 Aggregate 而不是简单拼接？
 * - Worker A 说"广州25°C多云"，Worker B 说"笔记里建议晴天防晒"
 * - 简单拼接："广州25°C多云。笔记里建议晴天防晒。" ← 生硬
 * - Aggregate："广州今天25°C多云，根据你的出行笔记，建议做好防晒。" ← 连贯自然
 */

import { detectLeakage } from "../guard/outputGuard.js";
import { callLLM } from "./llm.js";
import type { WorkerResult } from "./workers/types.js";

/** 最终回复过一遍 outputGuard，防 system / Worker prompt 泄露 */
function guardFinalOutput(text: string): string {
  const guard = detectLeakage(text);
  if (guard.leaked) {
    console.warn(
      `[OutputGuard] multi-agent 检测到泄露，已替换。命中: ${guard.matchedFingerprints.join(", ")}`,
    );
  }
  return guard.safeText;
}

/**
 * Aggregate 专属 system prompt。
 * 设计要点：
 * - 告知模型它的角色是"整合多个来源的信息"
 * - 要求输出连贯自然，不要像列表一样罗列
 * - 如果某个来源出错，要如实告知用户
 * - 不要添加来源之外的信息（避免编造）
 */
const AGGREGATE_SYSTEM_PROMPT =
  "你是一个信息整合助手。你会收到来自多个专业助手的回复，请将它们整合成一段连贯自然的回答。\n" +
  "规则：\n" +
  "- 保留每个来源的关键信息，不要遗漏\n" +
  "- 用自然语言组织，不要生硬地逐条列出\n" +
  "- 如果某个来源标注了错误，简要告知用户该部分信息暂时获取失败\n" +
  "- 不要添加来源之外的信息，不要编造\n" +
  "- 回复简洁，不要废话";

/** aggregate 的入参 */
interface AggregateOptions {
  /** 所有 Worker 的执行结果 */
  results: WorkerResult[];
  /** 用户的原始问题（给模型做上下文参考） */
  userMessage: string;
  /** LLM API Key */
  apiKey: string;
  /** LLM 接口地址 */
  baseUrl?: string;
  /** 模型名 */
  model?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** Token 统计回调 */
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

/**
 * 把 Worker 结果格式化成给 Aggregate 模型看的文本。
 *
 * 格式示例：
 *   [realtime] 广州当前25°C，多云。
 *   [kb] 根据你的笔记[1]，出行建议是晴天防晒。
 *   [general] (错误) 服务暂时不可用
 */
function formatWorkerResults(results: WorkerResult[]): string {
  return results
    .map((r) => {
      const prefix = `[${r.worker}]`;
      if (r.error) {
        return `${prefix} (错误) ${r.output}`;
      }
      return `${prefix} ${r.output}`;
    })
    .join("\n\n");
}

/**
 * 汇总多个 Worker 的结果，生成最终回复。
 *
 * @param options 包含 Worker 结果、用户原文、LLM 配置
 * @returns 最终回复文本
 *
 * 执行逻辑：
 * 1. 只有 1 个 Worker 且成功 → 直接返回其 output（省一次 LLM 调用）
 * 2. 多个 Worker 或有错误 → 调 LLM 汇总
 * 3. LLM 汇总调用失败 → 降级为简单拼接
 *
 * 示例：
 *   输入: results = [
 *     { worker:"realtime", output:"广州25°C多云", error:false },
 *     { worker:"kb", output:"笔记里说晴天防晒", error:false }
 *   ]
 *   输出: "广州今天25°C多云。根据你的出行笔记，建议做好防晒。"
 */
export async function aggregate(options: AggregateOptions): Promise<string> {
  const { results, userMessage, apiKey, signal } = options;

  // === 优化：单 Worker 且成功 → 直接透传，不浪费 LLM 调用 ===
  if (results.length === 1 && !results[0].error) {
    return guardFinalOutput(results[0].output);
  }

  // === 多 Worker 或有错误 → 调 LLM 汇总 ===

  /**
   * 构造给 Aggregate 模型的 user 消息：
   * - 先给出用户原始问题（让模型知道在回答什么）
   * - 再给出各 Worker 的结果（让模型知道有哪些素材）
   */
  const userContent =
    `用户问题：${userMessage}\n\n` +
    `以下是各专业助手的回复：\n${formatWorkerResults(results)}\n\n` +
    `请整合以上内容，给出一段连贯的最终回答。`;

  const result = await callLLM({
    messages: [
      { role: "system", content: AGGREGATE_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    signal,
    onUsage: options.onUsage,
    traceSpan: { role: "aggregate" },
  });

  // === 降级：LLM 汇总调用失败 → 简单拼接各 Worker 结果 ===
  if (!result.ok) {
    console.warn(`[Aggregate] LLM 汇总调用失败 (${result.status})，降级为简单拼接`);
    return guardFinalOutput(fallbackConcat(results));
  }

  if (!result.content) {
    console.warn("[Aggregate] 模型返回空内容，降级为简单拼接");
    return guardFinalOutput(fallbackConcat(results));
  }

  return guardFinalOutput(result.content);
}

/**
 * 降级拼接：当 Aggregate LLM 调用失败时，直接把各 Worker 结果拼起来。
 * 不如 LLM 汇总那么自然，但至少信息完整不丢。
 */
function fallbackConcat(results: WorkerResult[]): string {
  return results
    .map((r) => {
      if (r.error) return `⚠️ ${r.output}`;
      return r.output;
    })
    .join("\n\n");
}
