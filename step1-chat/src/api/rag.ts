import type { ChatRole, RagHitView, RagMeta } from "../types";

export interface AskRagParams {
  question: string;
  /** 当前问题之前的对话；不要把当前问句再塞进来，服务端会自己拼最后一条 user */
  history: Array<{ role: ChatRole; content: string }>;
  model: string;
  signal: AbortSignal;
}

function parseHits(raw: unknown): RagHitView[] {
  if (!Array.isArray(raw)) return [];
  const hits: RagHitView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.text !== "string" || typeof row.score !== "number") {
      continue;
    }
    hits.push({
      rank: typeof row.rank === "number" ? row.rank : hits.length + 1,
      rerankRank: typeof row.rerankRank === "number" ? row.rerankRank : null,
      promptIndex: typeof row.promptIndex === "number" ? row.promptIndex : null,
      id: row.id,
      source: typeof row.source === "string" ? row.source : "",
      title: typeof row.title === "string" ? row.title : "",
      text: row.text,
      score: row.score,
      rerankScore: typeof row.rerankScore === "number" ? row.rerankScore : null,
    });
  }
  return hits;
}

/**
 * 调独立的资料问答接口，不走 /api/chat。
 * 后端返回一整段 JSON，不是 SSE；空结果时 calledModel=false。
 * hits 是召回 TopK（无向量），promptIndex 有值表示这段进了发给模型的资料。
 */
export async function askRag({
  question,
  history,
  model,
  signal,
}: AskRagParams): Promise<{ ok: true; data: RagMeta & { answer: string } } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch("/api/rag/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, model }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "" };
    return { ok: false, error: error instanceof Error ? error.message : "网络请求失败" };
  }

  let payload: {
    error?: string;
    answer?: string;
    empty?: boolean;
    calledModel?: boolean;
    topScore?: number | null;
    question?: string;
    hits?: unknown;
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, error: `服务异常：${response.status}` };
  }

  if (!response.ok || payload.error) {
    return { ok: false, error: payload.error ?? `服务异常：${response.status}` };
  }
  if (typeof payload.answer !== "string") {
    return { ok: false, error: "资料问答返回格式不正确" };
  }

  return {
    ok: true,
    data: {
      answer: payload.answer,
      empty: Boolean(payload.empty),
      calledModel: Boolean(payload.calledModel),
      topScore: payload.topScore ?? null,
      question: typeof payload.question === "string" ? payload.question : question,
      hits: parseHits(payload.hits),
    },
  };
}
