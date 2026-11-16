import { embed } from "./embedding.js";
import { resolveKbRoute } from "./queryEnhance/kbRoute.js";
import { resolveQueryForRetrieve } from "./queryEnhance/index.js";
import {
  buildMultiQueries,
  disabledMultiQueryMeta,
  isMultiQueryEnabled,
  searchMultiQuery,
} from "./queryEnhance/multiQuery.js";
import {
  disabledHydeMeta,
  isHydeEnabled,
  resolveHydeQuery,
} from "./queryEnhance/hyde.js";
import type { HydeMeta, KbRoute, MultiQueryMeta } from "./queryEnhance/types.js";
// 动态知识库检索入口：分类可选（步骤 1/2 已支持），合并式方案的第二路召回
import { askKnowledge, type KbAskHit } from "../kb/search.js";
import { rerankHits, rerankerReady } from "./rerank.js";
import { LocalVectorStore } from "./vectorStore.js";
import type { RetrievalJudgment, SearchHit } from "./types.js";

/** 默认 TopK：Top1 易漏，Top20 太吵。 */
export const DEFAULT_TOP_K = 5;

/**
 * 分数闸门：Top1 低于此值，默认当作「资料里没有」。
 *
 * 设立原因：向量检索几乎总会排出 TopK。资料外问题（如「今天北京适合出门吗？」）
 * Top1 大约 0.28，若不拦，噪声块仍会进 prompt，模型容易瞎编。
 *
 * 已知误杀：只问文档标题时，正确块也能进 Top1，但短句对长块的余弦常落在 0.5～0.6。
 * 实测「不要在这个阶段做的事」命中 chunk-28（title 完全对得上），分数约 0.5571，
 * 若只看 0.6 会被判空。因此 judgeRetrieval 另有标题对上则放行的例外。
 *
 * 0.6 仍用于挡无关问题，不要为了标题问句把门槛降到 0.28 附近。
 */
export const MIN_TOP_SCORE = 0.6;

export interface RetrieveOptions {
  /** 单元 5：只在这些 source 上搜；null/undefined=全库；[]=空池 */
  sources?: string[] | null;
  /**
   * 动态知识库分类（可选，步骤 3 透传通道，步骤 4 合并时消费）：
   * 有值 → 动态库只在该分类内搜；无值 → 动态库全库搜。
   */
  category?: string | null;
}

/**
 * kbHitToSearchHit：把动态知识库命中（KbAskHit）适配成 RAG 检索命中（SearchHit）。
 * 为什么需要：两套库结果形状不同，合并前必须统一成同一个结构；
 * id/source 用「分类__文件名__块序号」拼，天然与离线 source 区分、可逆拆回展示。
 */
function kbHitToSearchHit(hit: KbAskHit): SearchHit {
  return {
    chunk: {
      // 唯一标识：分类__文件名__块序号（跨库去重 + 前端溯源的基础）
      id: `${hit.category}__${hit.source}__${hit.seq}`,
      // 来源标识：带分类前缀，与离线 notes 的同名文件不撞
      source: `${hit.category}__${hit.source}`,
      // 动态库块没有标题字段，用文件名兜底（标题点名闸门不会误判）
      title: hit.source,
      // 块正文原样透传：命中面板与 prompt 都读它
      text: hit.text,
      // 块序号原样透传
      seq: hit.seq,
      // embedding 置空：重排用交叉编码器、前端不展示向量，省内存省流量
      embedding: [],
      // 分类冗余保留：步骤 5 前端展示分类标签直接读这个字段
      category: hit.category,
    },
    // 相似度分数原样透传：跨库合并排序就靠它
    score: hit.score,
  };
}

/**
 * 按问题召回最像的若干段原文（原始 TopK，不做空结果判断）。
 * 步骤 4 起为合并式：离线 notes 库 + 动态知识库同时召回，按分数合并排序。
 * 空库不再是硬错误：离线库空 → []，动态库空 → []，交给判空闸门统一决定。
 *
 * 注意：这里的返回值「非空」只表示库里排得出名次，不表示资料够格回答。
 * 有没有资料交给 judgeRetrieval / retrieveForAnswer。
 */
export async function retrieve(
  question: string,
  topK = DEFAULT_TOP_K,
  options?: RetrieveOptions,
): Promise<SearchHit[]> {
  // 离线库：读入内存；文件缺失/损坏时 load 内部降级为空库
  const store = new LocalVectorStore();
  await store.load();
  // 问句只 embed 这一次给离线库用（动态库侧 askKnowledge 内部会再 embed，独立入口的代价）
  const [queryVec] = await embed([question]);
  // 离线候选：空库不再抛错，直接给 []（合并后由判空闸门兜底）
  const hitsFromNotes =
    store.size === 0
      ? []
      : await store.search(queryVec, topK, { sources: options?.sources });
  // 动态候选：分类可选——有值硬过滤，无值全库搜（步骤 1/2 的能力）
  const hitsFromKb = await askKnowledge({
    question,
    // 分类透传为空时动态库全库扫（null/undefined/空串语义一致）
    category: options?.category ?? undefined,
    // 与离线侧同用 topK（调用方传 candidateK），合并后再截断，避免一边挤掉另一边
    topK,
  });
  // 动态结果适配成 SearchHit 形状（id/source 带分类前缀，与离线不撞）
  const hitsFromKbAsSearchHit = hitsFromKb.map(kbHitToSearchHit);
  // 合并两套候选，按分数降序，取前 topK → 供判空闸门 + 重排使用
  return [...hitsFromNotes, ...hitsFromKbAsSearchHit]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 空结果判断：召回之后的闸门，不是召回本身。
 *
 * ## 为什么要两层
 * - retrieve / search = 召回：永远给相对最像的 K 段（库非空时几乎不会「搜不到」）
 * - 本函数 = 决定这 K 段能不能当资料用
 *
 * ## 只看分数会出的问题（学习时踩过）
 * 问句：「不要在这个阶段做的事」（文档 §10 的标题）
 * 召回：Top1 已是正确块 `stage3-rag-notes-chunk-28`，title 对得上
 * 分数：约 0.5571 < 0.6
 * 若只写 `topScore < 0.6 → empty`：面板上全是「未注入」，看起来像检索失败，
 * 其实是闸门把真命中扔掉了。短标题与整段正文语义重叠不够，分数上不去是正常现象。
 *
 * ## 当前规则
 * 1. 没有任何命中 → 空
 * 2. Top1 分数 ≥ minTopScore → 有资料（用原始 TopK 注入）
 * 3. 分数不够，但 Top1 的 title 与问句对得上（去掉「10. 」后互相包含）→ 仍视为有资料
 * 4. 否则 → 空（hits 清空，rawHits 保留给命中面板对照）
 *
 * 天气类问句标题对不上、分数又低，仍走第 4 条。
 */
export function judgeRetrieval(
  rawHits: SearchHit[],
  minTopScore = MIN_TOP_SCORE,
  question = "",
): RetrievalJudgment {
  const top = rawHits[0];
  const topScore = top?.score ?? null;
  const headingHit = Boolean(top && headingMatchesQuestion(top.chunk.title, question));
  const empty =
    rawHits.length === 0 ||
    topScore === null ||
    (topScore < minTopScore && !headingHit);

  if (empty) {
    return {
      empty: true,
      hits: [],
      rawHits,
      rankedAll: [],
      topScore,
      message: "资料里没有相关内容",
    };
  }

  return {
    empty: false,
    hits: rawHits,
    rawHits,
    rankedAll: [],
    topScore,
  };
}

/** 向量先多捞一些，重排后再切到 DEFAULT_TOP_K 注入。 */
export const CANDIDATE_K = 20;

export interface RetrieveForAnswerOptions {
  /** 扩写 / HyDE LLM 可中止（与聊天 AbortSignal 对齐） */
  signal?: AbortSignal;
  /** 单元 5 验收：强制 kb_route，覆盖规则与 env FORCE */
  forceKbRoute?: KbRoute | null;
  /** 扩写 LLM usage → bindUsageCallback(acc, "ragRewrite") */
  onRewriteUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
  /** HyDE LLM usage → bindUsageCallback(acc, "ragHyde") */
  onHydeUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
  /**
   * 动态知识库分类（可选）：路由层透传到 retrieve()，步骤 4 合并时消费。
   */
  category?: string | null;
  /**
   * 向量召回候选数（默认 CANDIDATE_K=20）。
   * 聊天 prefetch 可用更小值（如 CHAT_CANDIDATE_K=10）降重排成本。
   */
  candidateK?: number;
}

/**
 * 检索 + 空结果判断 + 重排。问答 / 拼 prompt 应走这一层。
 *
 * ## 单元 4 接线（问句增强）
 * 1. resolveQueryForRetrieve(原句) → queryUsed + rewriteMeta
 * 2. retrieve(queryUsed) 做向量召回
 * 3. judgeRetrieval / rerankHits 用 queryUsed
 *
 * ## 单元 5 接线（多库路由）
 * 在 embed 前 resolveKbRoute；route=none 时跳过 search（message 与分数判空区分）。
 * 否则 retrieve(..., { sources: sourcesAllowed })。
 *
 * ## 单元 6 接线（Multi-Query）
 * RAG_MULTI_QUERY=1 时：buildMultiQueries → 分路 search → max(score) 按 id 合并。
 * 闸门 / 重排仍用主路 query（queryUsed）；合并结果当 rawHits。
 *
 * ## 单元 7 接线（HyDE）
 * RAG_HYDE=1 时：生成假文档 → embed(假文档) → search。
 * 闸门标题比对 / 重排仍用 queryUsed（问句），不用假文档当「问句」。
 * 与 Multi-Query 同开时：优先 HyDE，跳过多路并打 warn（对照纪律：一次一招）。
 *
 * 开关：REWRITE / KB_ROUTE / MULTI_QUERY / HYDE 彼此独立；对照时一次只开一个召回增强。
 */
export async function retrieveForAnswer(
  question: string,
  topK = DEFAULT_TOP_K,
  minTopScore = MIN_TOP_SCORE,
  options?: RetrieveForAnswerOptions,
): Promise<RetrievalJudgment> {
  const candidateK = options?.candidateK ?? CANDIDATE_K;
  // ---- 步骤 1：原句 →（可选）扩写 ----
  const { query, meta } = await resolveQueryForRetrieve(question, {
    signal: options?.signal,
    onUsage: options?.onRewriteUsage,
  });
  if (meta.status === "ok" || meta.status === "fallback") {
    console.log(
      `[queryEnhance] status=${meta.status} original=${JSON.stringify(meta.original)} queryUsed=${JSON.stringify(meta.queryUsed)}`,
    );
  }

  // ---- 步骤 1.5：多库路由（单元 5）----
  // 用用户原句做关键词路由（比扩写句更稳）；intent 可来自 rewriteMeta
  const kbRouteMeta = resolveKbRoute({
    question: meta.original || question,
    rewriteMeta: meta,
    forceRoute: options?.forceKbRoute,
  });
  if (kbRouteMeta.status !== "disabled") {
    console.log(
      `[kbRoute] status=${kbRouteMeta.status} route=${kbRouteMeta.route} sources=${JSON.stringify(kbRouteMeta.sourcesAllowed)} reason=${kbRouteMeta.reason ?? ""}`,
    );
  }

  // none：跳过检索 —— 不是「分数低判空」，日志 / message 必须能区分
  if (kbRouteMeta.route === "none") {
    return {
      empty: true,
      hits: [],
      rawHits: [],
      rankedAll: [],
      topScore: null,
      message: "本轮路由为 none，跳过知识库检索",
      rewriteMeta: meta,
      kbRouteMeta,
      multiQueryMeta: disabledMultiQueryMeta(),
      hydeMeta: disabledHydeMeta(meta.original || question, query),
    };
  }

  // ---- 步骤 2～3：向量召回（HyDE / 多路 / 单路）----
  let rawHits: SearchHit[];
  let multiQueryMeta: MultiQueryMeta = disabledMultiQueryMeta();
  let hydeMeta: HydeMeta = disabledHydeMeta(meta.original || question, query);

  const hydeOn = isHydeEnabled();
  const multiOn = isMultiQueryEnabled();

  if (hydeOn && multiOn) {
    console.warn(
      "[hyde] RAG_HYDE 与 RAG_MULTI_QUERY 同时开启：本轮优先 HyDE，跳过多路（对照请一次只开一招）",
    );
  }

  if (hydeOn) {
    // 假文档失败则 embedText=query（扩写句或原句）
    const hyde = await resolveHydeQuery(meta.original || question, query, {
      signal: options?.signal,
      onUsage: options?.onHydeUsage,
    });
    hydeMeta = hyde.meta;
    if (hyde.meta.status === "ok") {
      console.log(
        `[hyde] status=ok chars=${hyde.meta.hydeDoc?.length ?? 0} preview=${JSON.stringify((hyde.meta.hydeDoc ?? "").slice(0, 120))}`,
      );
    } else if (hyde.meta.status === "fallback") {
      console.log(`[hyde] status=fallback reason=${hyde.meta.reason ?? ""}`);
    }
    rawHits = await retrieve(hyde.embedText, candidateK, {
      sources: kbRouteMeta.sourcesAllowed,
      // 分类透传（步骤 3 通道；HyDE 路径同样不丢）
      category: options?.category,
    });
    multiQueryMeta = {
      status: "skipped",
      queries: [],
      merge: "max_score",
      perQueryHitCounts: [],
      mergedCount: 0,
      reason: hydeOn && multiOn ? "与 HyDE 同开，本轮跳过多路" : "本轮走 HyDE",
    };
  } else if (multiOn) {
    const queries = buildMultiQueries(meta.original || question, meta);
    if (queries.length >= 2) {
      const multi = await searchMultiQuery(queries, {
        perQueryTopK: candidateK,
        mergeLimit: candidateK,
        sources: kbRouteMeta.sourcesAllowed,
      });
      rawHits = multi.hits;
      multiQueryMeta = multi.meta;
      console.log(
        `[multiQuery] status=ok n=${multi.meta.queries.length} merge=${multi.meta.merge} counts=${JSON.stringify(multi.meta.perQueryHitCounts)} merged=${multi.meta.mergedCount}`,
      );
      for (let i = 0; i < multi.meta.queries.length; i++) {
        console.log(
          `[multiQuery] q${i + 1}=${JSON.stringify(multi.meta.queries[i])} topIds=${JSON.stringify(multi.meta.perQueryTopIds?.[i] ?? [])}`,
        );
      }
    } else {
      // 拼不出 ≥2 路则退回单路，避免「开了开关却空转」
      rawHits = await retrieve(query, candidateK, {
        sources: kbRouteMeta.sourcesAllowed,
        // 分类透传（步骤 3 通道；退回单路时同样不丢）
        category: options?.category,
      });
      multiQueryMeta = {
        status: "skipped",
        queries,
        merge: "max_score",
        perQueryHitCounts: [],
        mergedCount: rawHits.length,
        reason: "有效问句不足 2 条，退回单路",
      };
      console.log(`[multiQuery] status=skipped reason=${multiQueryMeta.reason}`);
    }
  } else {
    rawHits = await retrieve(query, candidateK, {
      sources: kbRouteMeta.sourcesAllowed,
      // 分类透传（步骤 3 通道；默认单路检索）
      category: options?.category,
    });
  }

  // 闸门标题比对：仍用问句 query，不用假文档（假文档几乎对不上 title）
  const judged = judgeRetrieval(rawHits, minTopScore, query);
  if (judged.empty) {
    return { ...judged, rewriteMeta: meta, kbRouteMeta, multiQueryMeta, hydeMeta };
  }
  if (!rerankerReady()) {
    console.warn("重排模型未下载，暂用向量 TopK 注入。请运行 npm run predawn:rerank");
    return {
      ...judged,
      hits: judged.rawHits.slice(0, topK),
      rankedAll: [],
      rewriteMeta: meta,
      kbRouteMeta,
      multiQueryMeta,
      hydeMeta,
    };
  }
  // 重排问句仍用主路 query（queryUsed），不用假文档
  const { injected, rankedAll } = await rerankHits(query, judged.rawHits, topK);
  return {
    ...judged,
    hits: injected,
    rankedAll,
    rewriteMeta: meta,
    kbRouteMeta,
    multiQueryMeta,
    hydeMeta,
  };
}

/**
 * 标题点名：问句其实是在点文档某一节的标题，而不是在描述整段正文。
 * 向量分可能偏低，但 title 对得上就不应判空。
 * 编号「10. / 6.1」先剥掉再比，避免「10. 不要…」对不上「不要…」。
 */
function headingMatchesQuestion(title: string, question: string): boolean {
  const heading = normalizeHeading(title);
  const query = normalizeHeading(question);
  if (heading.length < 6 || query.length < 6) return false;
  return heading.includes(query) || query.includes(heading);
}

function normalizeHeading(text: string): string {
  return text
    .replace(/^\d+(\.\d+)*[.、．]\s*/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
