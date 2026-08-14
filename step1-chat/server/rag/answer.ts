import { completeRagMessages } from "./complete.js";
import { buildRagPrompt, type RagMessage } from "./prompt.js";
import { retrieveForAnswer } from "./retrieve.js";
import type { SearchHit } from "./types.js";

/** 给前端命中面板用：不含 embedding，避免把 1024 维向量打到浏览器。 */
export interface RagHitView {
  /** 向量召回排名（候选列表里的位置） */
  rank: number;
  /** 重排后的名次；未跑重排则为 null */
  rerankRank: number | null;
  /** 注入 prompt 时的 [n]；未注入则为 null */
  promptIndex: number | null;
  id: string;
  source: string;
  title: string;
  text: string;
  score: number;
  rerankScore: number | null;
}

export interface RagAnswer {
  empty: boolean;
  answer: string;
  calledModel: boolean;
  topScore: number | null;
  question: string;
  /** 原始召回 TopK；usedInPrompt 看 promptIndex 是否为 null */
  hits: RagHitView[];
}

function toPublicHits(
  rawHits: SearchHit[],
  rankedAll: SearchHit[],
  injected: SearchHit[],
): RagHitView[] {
  const promptIndexById = new Map(injected.map((hit, index) => [hit.chunk.id, index + 1]));
  const rerankRankById = new Map(rankedAll.map((hit, index) => [hit.chunk.id, index + 1]));
  const rerankScoreById = new Map(
    rankedAll.map((hit) => [hit.chunk.id, hit.rerankScore ?? null]),
  );

  return rawHits.map((hit, index) => ({
    rank: index + 1,
    rerankRank: rerankRankById.get(hit.chunk.id) ?? null,
    promptIndex: promptIndexById.get(hit.chunk.id) ?? null,
    id: hit.chunk.id,
    source: hit.chunk.source,
    title: hit.chunk.title,
    text: hit.chunk.text,
    score: hit.score,
    rerankScore: rerankScoreById.get(hit.chunk.id) ?? null,
  }));
}

/**
 * 问句 → 检索判空 → 拼 prompt →（有资料才）调 LLM。
 * 空结果直接返回固定文案，不消耗模型调用。
 * history 只应包含当前问题之前的 user/assistant，当前问句由 question 单独传入。
 */
export async function answerFromDocs(
  question: string,
  history: RagMessage[] = [],
  signal?: AbortSignal,
  model?: string,
): Promise<RagAnswer> {
  const trimmed = question.trim();
  const judgment = await retrieveForAnswer(trimmed);
  const prompt = buildRagPrompt({ question: trimmed, judgment, history });
  const hits = toPublicHits(judgment.rawHits, judgment.rankedAll, judgment.hits);
  if (prompt.empty) {
    return {
      empty: true,
      answer: prompt.message,
      calledModel: false,
      topScore: judgment.topScore,
      question: trimmed,
      hits,
    };
  }

  const answer = await completeRagMessages(prompt.messages, signal, model);
  return {
    empty: false,
    answer,
    calledModel: true,
    topScore: judgment.topScore,
    question: trimmed,
    hits,
  };
}
