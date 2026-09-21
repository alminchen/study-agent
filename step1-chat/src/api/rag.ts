import type {
  ChatRole,
  RagHitView,
  RagHydeMetaView,
  RagKbRouteMetaView,
  RagMeta,
  RagMultiQueryMetaView,
  RagRewriteMetaView,
  ToolTraceStep,
  UsageSnapshot,
} from "../types";

export interface AskRagParams {
  question: string;
  /** 当前问题之前的对话；不要把当前问句再塞进来，服务端会自己拼最后一条 user */
  history: Array<{ role: ChatRole; content: string }>;
  model: string;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  onRagMeta?: (meta: RagMeta & { outputLeakBlocked?: boolean; toolGuardBlocked?: boolean }) => void;
  onError: (error: string) => void;
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseRewriteMeta(raw: unknown): RagRewriteMetaView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.status !== "string" || typeof row.queryUsed !== "string") return null;
  return {
    status: row.status,
    original: typeof row.original === "string" ? row.original : "",
    queryUsed: row.queryUsed,
    rewritten: typeof row.rewritten === "string" ? row.rewritten : null,
    intent: typeof row.intent === "string" ? row.intent : null,
    keywords: asStringArray(row.keywords),
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function parseKbRouteMeta(raw: unknown): RagKbRouteMetaView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.status !== "string" || typeof row.route !== "string") return null;
  let sourcesAllowed: string[] | null = null;
  if (Array.isArray(row.sourcesAllowed)) {
    sourcesAllowed = asStringArray(row.sourcesAllowed);
  } else if (row.sourcesAllowed === null) {
    sourcesAllowed = null;
  }
  return {
    status: row.status,
    route: row.route,
    sourcesAllowed,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function parseMultiQueryMeta(raw: unknown): RagMultiQueryMetaView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.status !== "string") return null;
  return {
    status: row.status,
    queries: asStringArray(row.queries),
    merge: typeof row.merge === "string" ? row.merge : "max_score",
    mergedCount: typeof row.mergedCount === "number" ? row.mergedCount : 0,
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

function parseHydeMeta(raw: unknown): RagHydeMetaView | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.status !== "string") return null;
  return {
    status: row.status,
    hydeDoc: typeof row.hydeDoc === "string" ? row.hydeDoc : null,
    embedText: typeof row.embedText === "string" ? row.embedText : "",
    reason: typeof row.reason === "string" ? row.reason : undefined,
  };
}

/**
 * 资料问答：POST /api/rag/chat，响应为 SSE（与 streamChat 同形态）。
 * 事件：injection_detected? · tool_call/tool_result · output_leak_blocked?
 *       · rag_meta · delta · usage? · [DONE]
 */
export async function askRag({
  question,
  history,
  model,
  signal,
  onDelta,
  onTrace,
  onUsage,
  onRagMeta,
  onError,
}: AskRagParams): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/rag/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, model }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "网络请求失败");
    return false;
  }

  if (!response.ok) {
    onError(`服务异常：${response.status}`);
    return false;
  }
  if (!response.body) {
    onError("当前浏览器不支持流式响应");
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return true;
          try {
            const event = JSON.parse(payload) as {
              delta?: string;
              error?: string;
              type?: string;
              name?: string;
              arguments?: unknown;
              result?: unknown;
              level?: string;
              rules?: string[];
              matchedFingerprints?: string[];
              empty?: boolean;
              calledModel?: boolean;
              topScore?: number | null;
              question?: string;
              hits?: unknown;
              outputLeakBlocked?: boolean;
              toolGuardBlocked?: boolean;
              totalTokens?: number;
              promptTokens?: number;
              completionTokens?: number;
              llmCalls?: number;
              estimatedCostUsd?: number;
              model?: string;
              endpoint?: UsageSnapshot["endpoint"];
            };
            if (event.error) {
              onError(event.error);
              return true;
            }
            if (event.type === "usage" && typeof event.totalTokens === "number") {
              onUsage?.({
                endpoint: event.endpoint,
                model: event.model ?? model,
                promptTokens: event.promptTokens ?? 0,
                completionTokens: event.completionTokens ?? 0,
                totalTokens: event.totalTokens,
                llmCalls: event.llmCalls ?? 1,
                estimatedCostUsd: event.estimatedCostUsd ?? 0,
              });
            }
            if (event.type === "tool_call" && event.name) {
              onTrace?.({ kind: "tool_call", name: event.name, arguments: event.arguments });
            }
            if (event.type === "tool_result" && event.name) {
              onTrace?.({ kind: "tool_result", name: event.name, result: event.result });
            }
            if (event.type === "injection_detected") {
              onTrace?.({
                kind: "injection_detected",
                level: event.level,
                rules: Array.isArray(event.rules) ? event.rules : [],
              });
            }
            if (event.type === "output_leak_blocked") {
              onTrace?.({
                kind: "output_leak_blocked",
                matchedFingerprints: Array.isArray(event.matchedFingerprints)
                  ? event.matchedFingerprints
                  : [],
              });
            }
            if (event.type === "rag_meta") {
              const row = event as Record<string, unknown>;
              onRagMeta?.({
                empty: Boolean(event.empty),
                calledModel: Boolean(event.calledModel),
                topScore: event.topScore ?? null,
                question: typeof event.question === "string" ? event.question : question,
                hits: parseHits(event.hits),
                outputLeakBlocked: event.outputLeakBlocked,
                toolGuardBlocked: event.toolGuardBlocked,
                rewriteMeta: parseRewriteMeta(row.rewriteMeta),
                kbRouteMeta: parseKbRouteMeta(row.kbRouteMeta),
                multiQueryMeta: parseMultiQueryMeta(row.multiQueryMeta),
                hydeMeta: parseHydeMeta(row.hydeMeta),
              });
            }
            if (event.delta) onDelta(event.delta);
          } catch {
            // 忽略无法解析的中间数据
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "流式读取失败");
    return false;
  }
  return true;
}
