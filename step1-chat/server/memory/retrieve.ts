/**
 * 记忆检索：按当前问题挑出可能相关的记忆。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 *
 * 检索和「合并」用的是同一套向量，但门槛完全不同：
 *   合并 0.85 —— 判错会删掉一条记忆，代价大
 *   检索 0.45 —— 判错只是多注入一句上下文，代价小
 *
 * 检索阈值 0.45 是实测标定出来的，标定过程见 `scripts/check-memory-recall.ts`：
 * 相关对相似度落在 [0.499, 0.992]，无关对最高 0.393，两边可分离。
 *
 * 检索结果不会直接进上下文，还要经过第 5 项的预算裁剪。
 */

import {
  SIMILARITY_THRESHOLD,
  isFactDeleted,
  isFactExpired,
  isValidUserId,
  memoryEmbeddingText,
  type MemoryFact,
} from "./types.js";
import {
  cosineSimilarity,
  defaultMemoryEmbedder,
  isUsableVector,
  tryEmbed,
  type MemoryEmbedder,
} from "./embedder.js";
import { persistEmbeddings, readAllFacts } from "./store.js";

/** 一条命中结果：记忆本身 + 和问题的相似度。 */
export interface RetrievedMemory {
  fact: MemoryFact;
  similarity: number;
}

/** 检索可调参数。 */
export interface RetrieveOptions {
  /** 最多返回几条，默认 5。 */
  limit?: number;
  /** 相似度下限，默认 SIMILARITY_THRESHOLD。 */
  threshold?: number;
  /** 向量化实现，默认用本地 bge 模型。 */
  embedder?: MemoryEmbedder;
}

/**
 * 取出与问题相关的记忆，按相似度从高到低。
 *
 * 步骤：
 *   1. 读出该用户的全部记忆，过滤掉已删除、已过期的
 *   2. 给问题算向量
 *   3. 给没有缓存向量的旧记忆补算（并写回存储，下次不用再算）
 *   4. 余弦相似度 ≥ 阈值，取前 limit 条
 *
 * 任何一步失败都返回空数组——检索不到记忆只是「这次没注入上下文」，
 * 不该让聊天报错。
 */
export async function retrieveRelevantFacts(
  userId: string,
  question: string,
  options: RetrieveOptions = {},
): Promise<RetrievedMemory[]> {
  if (!isValidUserId(userId)) return [];
  const query = question.trim();
  if (!query) return [];

  const limit = options.limit ?? 5;
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const embedder = options.embedder ?? defaultMemoryEmbedder;

  const all = await readAllFacts(userId);
  const now = Date.now();
  const active = all.filter((fact) => !isFactDeleted(fact) && !isFactExpired(fact, now));
  if (active.length === 0) return [];

  // 没有向量的旧记忆要现场补算。
  const missing = active.filter((fact) => !isUsableVector(fact.embedding));
  const texts = [query, ...missing.map((fact) => memoryEmbeddingText(fact))];
  const vectors = await tryEmbed(texts, embedder);
  if (!vectors) return [];

  const queryVector = vectors[0];
  if (!isUsableVector(queryVector)) return [];
  const backfill = new Map<string, number[]>();
  const vectorByFactId = new Map<string, number[]>();
  missing.forEach((fact, index) => {
    const vector = vectors[index + 1];
    if (!isUsableVector(vector)) return;
    vectorByFactId.set(fact.id, vector);
    backfill.set(fact.id, vector);
  });

  // 补算结果写回存储，下次检索直接命中缓存。
  if (backfill.size > 0) {
    try {
      await persistEmbeddings(userId, backfill);
    } catch (error) {
      // 回写失败只影响下次的速度，不影响本次检索结果。
      console.warn("[memory] embedding 回写失败", { userId, error });
    }
  }

  return active
    .map((fact) => {
      const vector = isUsableVector(fact.embedding) ? fact.embedding : vectorByFactId.get(fact.id);
      if (!isUsableVector(vector)) return null;
      return { fact, similarity: cosineSimilarity(queryVector, vector) };
    })
    .filter((item): item is RetrievedMemory => item !== null)
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
