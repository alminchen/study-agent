import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";
import type { SearchHit } from "./types.js";

/** 交叉编码器：问句和一段原文成对打分，专门做重排，不是入库用的句向量模型。 */
const MODEL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../models/Xenova/bge-reranker-base",
);

const ONNX_FILE = path.join(MODEL_DIR, "onnx", "model_quantized.onnx");

type RerankTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type RerankModel = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

let tokenizer: RerankTokenizer | null = null;
let model: RerankModel | null = null;

export function rerankerReady(): boolean {
  return existsSync(ONNX_FILE);
}

/** P2: 供上层在检索后判断是否处于降级模式 */
export function isRerankDegraded(): boolean {
  return !existsSync(ONNX_FILE);
}

async function getReranker(): Promise<{ tokenizer: RerankTokenizer; model: RerankModel }> {
  if (!rerankerReady()) {
    throw new Error("重排模型未下载，请先运行 npm run predawn:rerank");
  }
  if (!tokenizer || !model) {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_DIR, { local_files_only: true });
    model = await AutoModelForSequenceClassification.from_pretrained(MODEL_DIR, {
      local_files_only: true,
      dtype: "q8",
    });
  }
  return { tokenizer, model };
}

function readLogit(output: { logits: { tolist: () => unknown } }): number {
  const raw = output.logits.tolist() as number[] | number[][];
  const first = raw[0];
  if (typeof first === "number") return first;
  if (Array.isArray(first) && typeof first[0] === "number") return first[0];
  throw new Error("重排模型输出格式异常");
}

/**
 * 对召回候选逐条打重排分，按分从高到低排，再切 keep 条给 prompt。
 * score 仍保留向量余弦，方便面板对比；rerankScore 是交叉编码器的 logit。
 */
export async function rerankHits(
  question: string,
  candidates: SearchHit[],
  keep: number,
): Promise<{ injected: SearchHit[]; rankedAll: SearchHit[] }> {
  if (candidates.length === 0) {
    return { injected: [], rankedAll: [] };
  }

  const { tokenizer: tok, model: net } = await getReranker();
  const ranked: SearchHit[] = [];

  for (const hit of candidates) {
    const inputs = tok(question, {
      text_pair: hit.chunk.text,
      truncation: true,
      max_length: 512,
    });
    const output = (await net(inputs)) as { logits: { tolist: () => unknown } };
    ranked.push({
      chunk: hit.chunk,
      score: hit.score,
      rerankScore: readLogit(output),
    });
  }

  ranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  return {
    rankedAll: ranked,
    injected: ranked.slice(0, keep),
  };
}
