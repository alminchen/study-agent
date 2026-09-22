import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/** bge-large-zh-v1.5 的向量维度，入库和提问必须一致。 */
export const EMBED_DIM = 1024;

const MODEL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../models/Xenova/bge-large-zh-v1.5",
);

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", MODEL_DIR, {
      local_files_only: true,
      dtype: "q8",
    });
  }
  return extractor;
}

/**
 * 把若干段文本编成向量。
 * pooling=mean + normalize=true 是句向量的正确用法；漏掉会直接搜不准。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ext = await getExtractor();
  const output = await ext(texts, { pooling: "mean", normalize: true });
  const rows = output.tolist() as number[][];
  for (const row of rows) {
    if (row.length !== EMBED_DIM) {
      throw new Error(`embedding 维度异常：期望 ${EMBED_DIM}，实际 ${row.length}`);
    }
  }
  return rows;
}

/**
 * 启动预热：加载 ONNX + 跑一条短句，避免首次检索卡在冷启动。
 * 模型目录缺失时抛错，由 warmup 层吞掉并打日志。
 */
export async function warmEmbed(): Promise<void> {
  await embed(["预热 embedding"]);
}

/** 余弦相似度，用来自测「同句应接近 1」。 */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
