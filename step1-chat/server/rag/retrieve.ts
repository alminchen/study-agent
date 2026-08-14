import { embed } from "./embedding.js";
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

/**
 * 按问题召回最像的若干段原文（原始 TopK，不做空结果判断）。
 * 问句和入库走同一个 embed()；还不调用聊天模型。
 *
 * 注意：这里的返回值「非空」只表示库里排得出名次，不表示资料够格回答。
 * 有没有资料交给 judgeRetrieval / retrieveForAnswer。
 */
export async function retrieve(question: string, topK = DEFAULT_TOP_K): Promise<SearchHit[]> {
  const store = new LocalVectorStore();
  await store.load();
  if (store.size === 0) {
    throw new Error("向量库是空的，请先运行 npm run rag:ingest");
  }
  const [queryVec] = await embed([question]);
  return store.search(queryVec, topK);
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

/** 检索 + 空结果判断 + 重排。问答 / 拼 prompt 应走这一层。 */
export async function retrieveForAnswer(
  question: string,
  topK = DEFAULT_TOP_K,
  minTopScore = MIN_TOP_SCORE,
): Promise<RetrievalJudgment> {
  const rawHits = await retrieve(question, CANDIDATE_K);
  const judged = judgeRetrieval(rawHits, minTopScore, question);
  if (judged.empty) {
    return judged;
  }
  if (!rerankerReady()) {
    console.warn("重排模型未下载，暂用向量 TopK 注入。请运行 npm run predawn:rerank");
    return {
      ...judged,
      hits: judged.rawHits.slice(0, topK),
      rankedAll: [],
    };
  }
  const { injected, rankedAll } = await rerankHits(question, judged.rawHits, topK);
  return {
    ...judged,
    hits: injected,
    rankedAll,
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
