import { normalizeKnowledgeAnswer } from "../answer-style/knowledgeAnswer.js";
import { detectInjection } from "../guard/inputGuard.js";
import { SAFE_BLOCK_TEXT } from "../guard/judgePolicy.js";
import { runInputJudge, type InputJudgeOutcome } from "../guard/judgeRuntime.js";
import { detectLeakage } from "../guard/outputGuard.js";
import { validateToolCall } from "../guard/toolCallGuard.js";
import type { ToolTraceHandler } from "../react/types.js";
import {
  runRagLlmWithTracing,
  runRagRetrieveWithTracing,
} from "../tracing/langsmith.js";
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
  /**
   * outputGuard 命中 system/资料规则指纹时为 true；
   * 此时 answer 已是 safeText 替换文案。
   */
  outputLeakBlocked?: boolean;
  /** 泄露检测命中的指纹（仅 outputLeakBlocked 时有） */
  matchedFingerprints?: string[];
  /** toolGuard 拒绝检索时为 true */
  toolGuardBlocked?: boolean;
  /** Judge 在 enforce 模式拦下检索片段（间接注入）时为 true */
  judgeBlocked?: boolean;
  /**
   * 检索前问句增强（单元 4）。
   * question 字段仍是用户原句；真正 embed 用的是 rewriteMeta.queryUsed。
   */
  rewriteMeta?: import("./queryEnhance/types.js").RewriteMeta;
  /** 多库路由（单元 5） */
  kbRouteMeta?: import("./queryEnhance/types.js").KbRouteMeta;
  /** 多路召回（单元 6） */
  multiQueryMeta?: import("./queryEnhance/types.js").MultiQueryMeta;
  /** HyDE 假文档检索（单元 7） */
  hydeMeta?: import("./queryEnhance/types.js").HydeMeta;
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
 * 问句 → toolGuard(searchDocs) → 检索判空 → 拼 prompt →（有资料才）调 LLM。
 * 空结果直接返回固定文案，不消耗模型调用。
 * history 只应包含当前问题之前的 user/assistant，当前问句由 question 单独传入。
 *
 * 安全（与单 Agent 对齐语义）：
 * - Tool：检索前 validateToolCall("searchDocs", { question })；拒绝则不 retrieve、不调模型。
 * - Output：模型回复经 normalizeKnowledgeAnswer 后再 detectLeakage；泄露则换 safeText。
 * - Input：由 routes/ragChat.ts 对 question 调 detectInjection（只标记；SSE injection_detected）。
 * - Trace：onTrace 推 tool_call / tool_result / output_leak_blocked（SSE）。
 * - LangSmith：retrieve / LLM 分别走 runRagRetrieveWithTracing / runRagLlmWithTracing。
 */
export async function answerFromDocs(
  question: string,
  history: RagMessage[] = [],
  signal?: AbortSignal,
  model?: string,
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void,
  onTrace?: ToolTraceHandler,
  usageHooks?: {
    onRewriteUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
    onHydeUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
  },
): Promise<RagAnswer> {
  const trimmed = question.trim();
  const rawArgs = JSON.stringify({ question: trimmed });

  // ---- Tool Guard：把「内部检索」当成 searchDocs 白名单调用校验（与 chat 工具层对齐）----
  onTrace?.({ type: "tool_call", name: "searchDocs", arguments: { question: trimmed } });
  const toolGuard = validateToolCall("searchDocs", rawArgs);
  if (!toolGuard.allowed) {
    const reason = toolGuard.reason ?? "工具调用被拒绝";
    onTrace?.({ type: "tool_result", name: "searchDocs", result: { error: reason } });
    return {
      empty: true,
      answer: `检索被拦截：${reason}`,
      calledModel: false,
      topScore: null,
      question: trimmed,
      hits: [],
      toolGuardBlocked: true,
    };
  }

  const judgment = await runRagRetrieveWithTracing(trimmed, async () => {
    // signal 传入：用户停止时扩写 / HyDE HTTP 也能 abort
    const result = await retrieveForAnswer(trimmed, undefined, undefined, {
      signal,
      onRewriteUsage: usageHooks?.onRewriteUsage,
      onHydeUsage: usageHooks?.onHydeUsage,
    });
    return {
      ...result,
      // 供 LangSmith processOutputs 摘要（不影响后续解构）
      hitCount: result.rawHits.length,
    };
  });

  onTrace?.({
    type: "tool_result",
    name: "searchDocs",
    result: {
      empty: judgment.empty,
      topScore: judgment.topScore,
      hitCount: judgment.rawHits.length,
      injectedCount: judgment.hits.length,
      // 过程面板可见：扩写是否启用 / 用了哪句去搜（不替代 hits 详情）
      rewrite: judgment.rewriteMeta
        ? {
            status: judgment.rewriteMeta.status,
            queryUsed: judgment.rewriteMeta.queryUsed,
            intent: judgment.rewriteMeta.intent,
          }
        : undefined,
      kbRoute: judgment.kbRouteMeta
        ? {
            status: judgment.kbRouteMeta.status,
            route: judgment.kbRouteMeta.route,
            sourcesAllowed: judgment.kbRouteMeta.sourcesAllowed,
          }
        : undefined,
      multiQuery: judgment.multiQueryMeta
        ? {
            status: judgment.multiQueryMeta.status,
            n: judgment.multiQueryMeta.queries.length,
            merge: judgment.multiQueryMeta.merge,
            mergedCount: judgment.multiQueryMeta.mergedCount,
          }
        : undefined,
      hyde: judgment.hydeMeta
        ? {
            status: judgment.hydeMeta.status,
            chars: judgment.hydeMeta.hydeDoc?.length ?? 0,
            preview: (judgment.hydeMeta.hydeDoc ?? "").slice(0, 80) || undefined,
          }
        : undefined,
    },
  });

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
      rewriteMeta: judgment.rewriteMeta,
      kbRouteMeta: judgment.kbRouteMeta,
      multiQueryMeta: judgment.multiQueryMeta,
      hydeMeta: judgment.hydeMeta,
    };
  }

  const resolvedModel = model || process.env.LLM_MODEL || "deepseek-chat";

  // ---- LLM-as-Judge（enforce）：对进入 prompt 的检索片段做一次判定 ----
  // 检索片段是间接注入的主要入口：知识库文档里写着「忽略之前的指令」，
  // 模型会照做。这条链路此前没有任何保护，所以命中即拦；off/shadow 链路零变化。
  const chunkOutcome = await judgeRetrievedChunks(judgment.hits, onTrace);
  if (chunkOutcome?.action === "block") {
    return {
      empty: false,
      answer: chunkOutcome.safeText ?? SAFE_BLOCK_TEXT,
      calledModel: false,
      topScore: judgment.topScore,
      question: trimmed,
      hits,
      judgeBlocked: true,
      rewriteMeta: judgment.rewriteMeta,
      kbRouteMeta: judgment.kbRouteMeta,
      multiQueryMeta: judgment.multiQueryMeta,
      hydeMeta: judgment.hydeMeta,
    };
  }

  const { content } = await runRagLlmWithTracing(prompt.messages.length, resolvedModel, () =>
    completeRagMessages(prompt.messages, signal, model, onUsage),
  );
  const normalized = normalizeKnowledgeAnswer(content);
  // ---- outputGuard：防 RAG system / 规则指纹泄露（对齐 chat reply / multi aggregate）----
  const leak = detectLeakage(normalized);
  if (leak.leaked) {
    console.warn(
      `[OutputGuard] rag 检测到 system/规则泄露，已替换。命中: ${leak.matchedFingerprints.join(", ")}`,
    );
    onTrace?.({
      type: "output_leak_blocked",
      matchedFingerprints: leak.matchedFingerprints,
    });
  }
  return {
    empty: false,
    answer: leak.safeText,
    calledModel: true,
    topScore: judgment.topScore,
    question: trimmed,
    hits,
    outputLeakBlocked: leak.leaked ? true : undefined,
    matchedFingerprints: leak.leaked ? leak.matchedFingerprints : undefined,
    rewriteMeta: judgment.rewriteMeta,
    kbRouteMeta: judgment.kbRouteMeta,
    multiQueryMeta: judgment.multiQueryMeta,
    hydeMeta: judgment.hydeMeta,
  };
}

/**
 * 对即将进入 prompt 的检索片段跑一次判定。
 *
 * 与用户输入的差别：用户输入那条链路本来就有正则「只标记不拦截」，
 * 规则优先是为了维持现状；检索片段此前完全裸奔，高危命中直接拦。
 *
 * off 模式下 runInputJudge 直接返回（不调模型），shadow 只写 trace 不改答案。
 */
async function judgeRetrievedChunks(
  hits: { chunk: { text: string } }[],
  onTrace?: ToolTraceHandler,
): Promise<InputJudgeOutcome | null> {
  const chunkText = hits.map((hit) => hit.chunk.text).join("\n");
  if (!chunkText.trim()) return null;

  const guard = detectInjection(chunkText);
  return runInputJudge({
    text: chunkText,
    guard: { level: guard.level, rules: guard.matchedRules },
    surface: "retrieval",
    subject: "检索到的资料片段",
    emit: (event) => onTrace?.(event),
  });
}
