/**
 * 记忆去重与合并。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 *
 * 一条新抽取出来的事实要并进已有记忆时，有三层判断：
 *
 *   1. 同 key 同值   → 不是新事实，刷新时间、置信度取高者（别把同一件事记两遍）
 *   2. 同 key 不同值 → 事实冲突，标记 conflict 等用户裁决，**不自动覆盖**
 *   3. key 不同但语义几乎一样 → 同一件事的两种说法，合并成一条，
 *      保留置信度高的那条，另一条软删除（deletedAt，历史仍可审计）
 *
 * 第 3 条为什么要这么严（0.85 而不是检索用的 0.45）：
 * 合并会直接删掉一条记忆，误判的代价远大于「少召回一条」。
 * 而且判定用的是**两重条件**：key 像 **且** value 像。
 * 只满足 key 像的话，「db: PostgreSQL」和「database: MySQL」会被错当成一条。
 */

import {
  SEMANTIC_MERGE_THRESHOLD,
  isFactDeleted,
  isFactExpired,
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

/** 合并时可调的参数。 */
export interface MergeOptions {
  /** 向量化实现，默认用本地 bge 模型。 */
  embedder?: MemoryEmbedder;
  /** 语义合并阈值，默认 SEMANTIC_MERGE_THRESHOLD。 */
  semanticThreshold?: number;
}

/** 判断一条事实当前是否生效（没删、没过期）。 */
function isActive(fact: MemoryFact, now: number): boolean {
  return !isFactDeleted(fact) && !isFactExpired(fact, now);
}

/**
 * 同 key 的合并规则（纯函数，不碰模型）。
 *
 * 返回整个新的事实列表。matched 表示是否撞上了同 key 的已有事实。
 */
export interface KeyMergeResult {
  /** 合并后的全部事实列表（含软删除记录）。 */
  facts: MemoryFact[];
  /** 是否撞上了同 key 的已有事实。 */
  matched: boolean;
  /**
   * 合并后「活下来的那一条」。
   *
   * API 需要知道它才能把正确的那条返回给前端：
   * 同 key 同值时活下来的是被刷新的旧记录，
   * 同 key 不同值时活下来的也是旧记录（只是被标了冲突），
   * 只有语义合并时，活下来的才可能是新来的那条。
   */
  survivor: MemoryFact | null;
  /** 是否产生了同 key 不同值的冲突。 */
  conflict: boolean;
  /** 冲突时对方持有的值（面板里的「用新值」按钮要用它）。 */
  conflictingValue?: string;
}

export function mergeFactByKey(
  facts: MemoryFact[],
  incoming: MemoryFact,
  now: number,
): KeyMergeResult {
  const target = facts.find((fact) => fact.key === incoming.key && isActive(fact, now));
  if (!target) return { facts, matched: false, survivor: null, conflict: false };

  // 同 key 同值：不是新事实，只是这条又被确认了一次。
  if (target.value === incoming.value) {
    const refreshed: MemoryFact = {
      ...target,
      updatedAt: incoming.updatedAt,
      confidence: Math.max(target.confidence, incoming.confidence),
      conflict: false,
      conflictingValue: undefined,
      embedding: target.embedding ?? incoming.embedding,
    };
    return {
      facts: facts.map((fact) => (fact === target ? refreshed : fact)),
      matched: true,
      survivor: refreshed,
      conflict: false,
    };
  }

  // 同 key 不同值：事实冲突，交用户在面板里裁决，绝不自动覆盖。
  const conflicted: MemoryFact = {
    ...target,
    conflict: true,
    conflictingValue: incoming.value,
    updatedAt: incoming.updatedAt,
  };
  return {
    facts: facts.map((fact) => (fact === target ? conflicted : fact)),
    matched: true,
    survivor: conflicted,
    conflict: true,
    conflictingValue: incoming.value,
  };
}

/**
 * 语义合并：key 不同、但说的是同一件事时，合并成一条。
 *
 * 两段式判定，避免把不同的事实合并掉：
 *   预筛 —— 用缓存的 `key: value` 向量粗筛出候选（便宜，一次比较）
 *   细判 —— 只有候选才去算 key 向量和 value 向量，
 *           要求「key 相似 > 阈值 且 value 相似 > 阈值」才真的合并
 *
 * 预筛是必要的：每次写入都给全部已有记忆重算两组向量太贵，
 * 而细判只发生在少数候选上。
 */
async function mergeBySemantics(
  facts: MemoryFact[],
  incoming: MemoryFact,
  options: MergeOptions,
  now: number,
): Promise<{ facts: MemoryFact[]; survivor: MemoryFact } | null> {
  const threshold = options.semanticThreshold ?? SEMANTIC_MERGE_THRESHOLD;
  const embedder = options.embedder ?? defaultMemoryEmbedder;

  // 冲突中的事实先不参与语义合并：它本身还没定下来。
  const candidates = facts.filter(
    (fact) =>
      isActive(fact, now) &&
      fact.key !== incoming.key &&
      !fact.conflict &&
      isUsableVector(fact.embedding),
  );
  if (candidates.length === 0 || !isUsableVector(incoming.embedding)) return null;

  // 预筛：combined 向量足够接近的才值得细判。
  const near = candidates.filter(
    (fact) => cosineSimilarity(fact.embedding as number[], incoming.embedding as number[]) > threshold,
  );
  if (near.length === 0) return null;

  // 细判：key 像 且 value 像。
  const texts = [
    ...near.map((fact) => fact.key),
    incoming.key,
    ...near.map((fact) => fact.value),
    incoming.value,
  ];
  const vectors = await tryEmbed(texts, embedder);
  if (!vectors) return null;

  const count = near.length;
  const incomingKeyVector = vectors[count];
  const incomingValueVector = vectors[count * 2 + 1];

  for (let index = 0; index < count; index++) {
    const keySimilarity = cosineSimilarity(vectors[index], incomingKeyVector);
    const valueSimilarity = cosineSimilarity(vectors[count + 1 + index], incomingValueVector);
    if (keySimilarity <= threshold || valueSimilarity <= threshold) continue;

    const existing = near[index];
    // 置信度高的一条活下来；另一条软删除，记录留在磁盘上可审计。
    if (incoming.confidence > existing.confidence) {
      const deletedAt = now;
      const deletedExisting: MemoryFact = { ...existing, deletedAt, updatedAt: now };
      const survivor: MemoryFact = { ...incoming };
      return {
        facts: [
          ...facts.map((fact) => (fact === existing ? deletedExisting : fact)),
          survivor,
        ],
        survivor,
      };
    }
    const deletedIncoming: MemoryFact = { ...incoming, deletedAt: now, updatedAt: now };
    const survivor: MemoryFact = {
      ...existing,
      updatedAt: now,
      confidence: Math.max(existing.confidence, incoming.confidence),
      embedding: existing.embedding ?? incoming.embedding,
    };
    return {
      facts: [
        ...facts.map((fact) => (fact === existing ? survivor : fact)),
        deletedIncoming,
      ],
      survivor,
    };
  }

  return null;
}

/**
 * 把一条新事实并进已有事实列表。
 *
 * 纯函数语义（不改传入的数组），但因为要做 embedding 所以是异步的。
 */
export interface MergeOutcome {
  /** 合并后的全部事实列表（含软删除记录）。 */
  facts: MemoryFact[];
  /** 合并后活下来的那一条；理论上不会是 null（除非 incoming 自己就不可用）。 */
  survivor: MemoryFact | null;
  /** 是否产生了同 key 不同值的冲突。 */
  conflict: boolean;
  /** 冲突时对方持有的值。 */
  conflictingValue?: string;
}

export async function mergeIncomingFact(
  facts: MemoryFact[],
  incoming: MemoryFact,
  options: MergeOptions = {},
): Promise<MergeOutcome> {
  const now = Date.now();

  const byKey = mergeFactByKey(facts, incoming, now);
  if (byKey.matched) {
    return {
      facts: byKey.facts,
      survivor: byKey.survivor,
      conflict: byKey.conflict,
      conflictingValue: byKey.conflictingValue,
    };
  }

  const bySemantics = await mergeBySemantics(byKey.facts, incoming, options, now);
  if (bySemantics) {
    // 语义合并不会产生冲突：活下来的那条就是唯一的一条。
    return { facts: bySemantics.facts, survivor: bySemantics.survivor, conflict: false };
  }

  return { facts: [...byKey.facts, incoming], survivor: incoming, conflict: false };
}

/**
 * 给缺向量的事实补算 embedding（幂等）。
 *
 * 单条写入和批量写入都要用，抽出来复用：
 * 单条路径（API 手写一条记忆）不能因为「只有一条」就跳过向量化，
 * 否则它永远没有向量、语义检索永远召不回它。
 */
export async function ensureEmbeddings(
  facts: MemoryFact[],
  incoming: MemoryFact[],
  embedder: MemoryEmbedder,
): Promise<void> {
  const pendingTexts: string[] = [];
  const seen = new Set<string>();
  const collect = (fact: MemoryFact): void => {
    if (isUsableVector(fact.embedding)) return;
    const text = memoryEmbeddingText(fact);
    if (seen.has(text)) return;
    seen.add(text);
    pendingTexts.push(text);
  };
  incoming.forEach(collect);
  const now = Date.now();
  facts.filter((fact) => isActive(fact, now)).forEach(collect);

  if (pendingTexts.length === 0) return;

  const vectors = await tryEmbed(pendingTexts, embedder);
  if (!vectors) return;
  const vectorByText = new Map(pendingTexts.map((text, index) => [text, vectors[index]]));
  for (const fact of [...facts, ...incoming]) {
    if (isUsableVector(fact.embedding)) continue;
    const vector = vectorByText.get(memoryEmbeddingText(fact));
    if (isUsableVector(vector)) fact.embedding = vector;
  }
}

/**
 * 批量合并：新抽取的事实一次性并进已有记忆。
 *
 * 为什么要批量而不是一条条调：
 * embedding 是这个流程里唯一的大头（模型推理），
 * 批量调用能把 N 次推理压成 1~2 次。
 */
export async function mergeIncomingFacts(
  facts: MemoryFact[],
  incomingFacts: MemoryFact[],
  options: MergeOptions = {},
): Promise<MemoryFact[]> {
  if (incomingFacts.length === 0) return facts;
  const embedder = options.embedder ?? defaultMemoryEmbedder;

  // 第一步：把缺的向量一次性补齐（新事实 + 还没缓存向量的旧事实）。
  await ensureEmbeddings(facts, incomingFacts, embedder);

  // 第二步：逐条套用合并规则。
  let merged = facts;
  for (const incoming of incomingFacts) {
    merged = (await mergeIncomingFact(merged, incoming, options)).facts;
  }
  return merged;
}
