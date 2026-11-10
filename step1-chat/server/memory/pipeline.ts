/**
 * 记忆链路的两端编排：检索注入（C2）与抽取落盘（C1）。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 *
 * 为什么单独抽一层
 *
 * retrieve.ts 和 extract.ts 是纯能力，但聊天链路还需要一层「把它们接起来」的东西：
 *
 * - 抽取出来的候选要变成 MemoryFact（补 id、补时间戳）再落盘；
 * - 落盘后要能回答「这一轮到底存下了什么」，
 *   才能给前端发 memory_extracted 事件。
 *
 * 这层不碰网络、不碰 HTTP，只做编排，所以可以直接单测。
 */

import { createMemoryFact, readAllFacts, upsertFacts } from "./store.js";
import {
  extractMemoryFacts,
  type MemoryConversationMessage,
  type MemoryModelCaller,
} from "./extract.js";
import { isValidUserId, type MemoryFact } from "./types.js";

/** 抽取并落盘所需的参数。 */
export interface MemoryExtractionParams {
  /** 归属的匿名用户 id。 */
  userId: string;
  /** 本轮对话（只取 user / assistant）。 */
  messages: MemoryConversationMessage[];
  /** 模型调用入口。 */
  callModel: MemoryModelCaller;
  /** 中止信号。 */
  signal?: AbortSignal;
  /** 整次抽取的耗时上限，默认 8000ms。 */
  timeoutMs?: number;
}

/** 抽取结果。 */
export interface MemoryExtractionOutcome {
  /** 模型给出的候选条数（已过置信度与敏感信息闸门）。 */
  candidates: number;
  /** 真正落盘（或更新）的记忆条目。 */
  stored: MemoryFact[];
}

/**
 * 抽取候选事实并落盘。
 *
 * 「存下了什么」的判定方式：**落盘前后对比**。
 * 合并层会把同 key 的旧记忆就地更新（id 不变），
 * 只看最终列表没法区分「新增」和「更新」，所以这里先拍一张旧快照再比对。
 */
export async function extractAndStoreFacts(
  params: MemoryExtractionParams,
): Promise<MemoryExtractionOutcome> {
  const { userId, messages, callModel, signal, timeoutMs = 8_000 } = params;
  if (!isValidUserId(userId)) return { candidates: 0, stored: [] };

  const candidates = await extractMemoryFacts(messages, {
    callModel,
    userId,
    signal,
    timeoutMs,
  });
  if (candidates.length === 0) return { candidates: 0, stored: [] };

  // 旧快照：用来判断哪些条目是这次真正动过的。
  const before = await readAllFacts(userId);
  const beforeByKey = new Map(before.map((fact) => [fact.key, fact]));

  const incoming = candidates.map((candidate) =>
    createMemoryFact({
      userId,
      key: candidate.key,
      value: candidate.value,
      source: candidate.source,
      confidence: candidate.confidence,
    }),
  );

  const merged = await upsertFacts(userId, incoming);
  const stored = merged.filter((fact) => {
    const previous = beforeByKey.get(fact.key);
    if (!previous) return true;
    return previous.value !== fact.value || previous.updatedAt !== fact.updatedAt;
  });

  return { candidates: candidates.length, stored };
}
