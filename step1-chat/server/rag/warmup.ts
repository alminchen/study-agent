/**
 * RAG 模型启动预热（post-learning P1）。
 *
 * 首次请求再加载 bge-large / bge-reranker 会多卡几秒；
 * 服务起来后后台预热，把冷启动从「用户第一次问」挪到「进程启动」。
 *
 * 开关：RAG_WARMUP=1（默认开）| 0 关闭
 */

import { warmEmbed } from "./embedding.js";
import { rerankerReady, warmRerank } from "./rerank.js";

function warmupEnabled(): boolean {
  const flag = (process.env.RAG_WARMUP ?? "1").trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "off";
}

/**
 * 后台预热；不阻塞 listen。
 * 缺模型时只 warn，不拖垮 API 进程。
 */
export async function warmRagModels(): Promise<void> {
  if (!warmupEnabled()) {
    console.log("[rag-warmup] 已跳过（RAG_WARMUP=0）");
    return;
  }

  const started = Date.now();
  console.log("[rag-warmup] 开始预热 embedding / reranker …");

  try {
    await warmEmbed();
    console.log(`[rag-warmup] embedding 就绪（${Date.now() - started}ms）`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[rag-warmup] embedding 失败（可稍后 npm run predawn:bge）：${msg}`);
  }

  if (!rerankerReady()) {
    console.warn("[rag-warmup] reranker 未下载，跳过（npm run predawn:rerank）");
    return;
  }

  try {
    const t0 = Date.now();
    await warmRerank();
    console.log(`[rag-warmup] reranker 就绪（本段 ${Date.now() - t0}ms，累计 ${Date.now() - started}ms）`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[rag-warmup] reranker 失败：${msg}`);
  }
}
