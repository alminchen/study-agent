/**
 * 长上下文管理的类型定义。
 *
 * 这一层是「早期记忆」的线协议：前端生成摘要并持久化，请求时带回来，
 * 服务端校验后作为**独立**的一条 system 消息注入（不是指令，是资料）。
 *
 * 版本约定：结构变了就把 CONTEXT_SUMMARY_VERSION +1。
 * 服务端遇到不认识的版本直接忽略摘要（等同没有摘要），不报错、不透传。
 */
import type { TextMessage } from "../react/types.js";

/** 摘要结构版本号。 */
export const CONTEXT_SUMMARY_VERSION = 1;

/** 摘要里的一条普通条目（决定、约束、未决事项共用这个形状）。 */
export interface ContextSummaryItem {
  text: string;
  /** 这条内容来自 messages 数组的第几条（原始下标，用于回溯与去重）。 */
  sourceMessageIndex: number;
}

/** 摘要里的一条事实：带 key，方便前端按 key 更新而不是重复追加。 */
export interface ContextFact {
  key: string;
  value: string;
  sourceMessageIndex: number;
}

/** 结构化上下文摘要：整个阶段要保留的「早期记忆」。 */
export interface ContextSummary {
  version: number;
  /** 摘要生成时间（毫秒时间戳）。 */
  updatedAt: number;
  /**
   * 摘要覆盖到哪条消息（id 口径）。
   * 前端历史里的 ChatMessage 有 id，但目前发给服务端的请求体还不带 id，
   * 所以服务端去重主要靠下面的 compactedUntilIndex；这个字段留给 UI 展示与将来对齐。
   */
  compactedUntilMessageId: string | null;
  /**
   * 摘要覆盖到 messages 数组的哪一条（含该下标，-1 表示没覆盖任何一条）。
   * 摘要总是从**最早**的消息开始连续覆盖，所以一个下标就能精确表达覆盖范围：
   * 服务端收到摘要后，会把下标 <= 它的旧消息直接丢掉，避免摘要与原文重复。
   */
  compactedUntilIndex?: number;
  facts: ContextFact[];
 decisions: ContextSummaryItem[];
  unresolved: ContextSummaryItem[];
  /** 用户明确的约束（语言、风格、禁止项），优先级最高。 */
  userConstraints: ContextSummaryItem[];
}

/** buildContext 的返回值。 */
export interface ContextBuildResult {
  /** 最终发给模型的 messages：system → 摘要 → 近期原文。 */
  messages: TextMessage[];
  /** 被丢掉、还没被摘要覆盖的原始消息（按原顺序）。 */
  droppedMessages: TextMessage[];
  /**
   * droppedMessages 每条在原始 messages 数组里的下标（与 droppedMessages 一一对应）。
   * 摘要条目必须带 sourceMessageIndex，摘要生成器靠它标出内容来自哪一轮。
   */
  droppedMessageIndices: number[];
  /** 最终注入内容的估算 token（未乘安全系数）。 */
  estimatedTokens: number;
  /** 实际生效的预算（正常等于传入值；预算被 system 吃光时会抬高，见 buildContext）。 */
  budgetTokens: number;
  /** 是否真的注入了摘要（版本不认识 / 摘要超预算时为 false）。 */
  usedSummary: boolean;
  /** 是否处于降级状态（摘要不可用时置 true，由调用方在 SSE 里告知前端）。 */
  degraded: boolean;
}

/**
 * SSE 事件 context_compacted 的载荷。
 *
 * 这里刻意用 type 而不是 interface：type 别名的对象字面量类型会有隐式索引签名，
 * 可以直接当 Record<string, unknown> 用（各路由的 writeSse 就是这么收事件的）。
 */
export type ContextCompactionEvent = {
  type: "context_compacted";
  /** 本轮被压缩掉的轮数。 */
  compactedRounds: number;
  /** 压缩前这些消息的估算 token。 */
  originalTokens: number;
  /** 压缩后注入的估算 token。 */
  compactedTokens: number;
  /** 摘要本身占的估算 token。 */
  summaryTokens: number;
  /** 摘要不可用、本轮只按预算裁剪。 */
  degraded: boolean;
  /**
   * 本轮生成的新摘要。
   * 摘要失败（degraded=true）时为 null——此时不注入任何摘要，聊天照常继续。
   */
  summary?: ContextSummary | null;
};
