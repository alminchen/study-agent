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

/** 每批打分条数；1 = 完全串行。可用 RERANK_BATCH_SIZE 覆盖（默认 8）。 */
export function rerankBatchSize(): number {
  const raw = Number(process.env.RERANK_BATCH_SIZE ?? "8");
  if (!Number.isFinite(raw) || raw < 1) return 8;
  return Math.min(Math.floor(raw), 32);
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

function readLogit(output: { logits: { tolist: () => unknown; data?: Float32Array | number[] } }): number {
  const scores = readLogitsBatch(output, 1);
  return scores[0] ?? 0;
}

/**
 * 从模型输出抽出 batch 个 logit。
 * 兼容 logits.tolist() 为 number[] / number[][]，以及 logits.data 扁平数组。
 */
function readLogitsBatch(
  output: { logits: { tolist: () => unknown; data?: Float32Array | number[] } },
  expected: number,
): number[] {
  const raw = output.logits.tolist() as number[] | number[][];
  if (Array.isArray(raw) && raw.length > 0) {
    if (typeof raw[0] === "number") {
      return (raw as number[]).slice(0, expected);
    }
    return (raw as number[][]).map((row) => {
      if (typeof row[0] === "number") return row[0];
      throw new Error("重排模型输出格式异常");
    }).slice(0, expected);
  }
  const data = output.logits.data;
  if (data && data.length >= expected) {
    return Array.from(data).slice(0, expected);
  }
  throw new Error("重排模型输出格式异常");
}

/** 单条打分（batch 失败时的回退）。 */
async function scoreOne(
  tok: RerankTokenizer,
  net: RerankModel,
  question: string,
  text: string,
): Promise<number> {
  const inputs = tok(question, {
    text_pair: text,
    truncation: true,
    max_length: 512,
  });
  const output = (await net(inputs)) as { logits: { tolist: () => unknown } };
  return readLogit(output);
}

/**
 * 对若干原文打重排分：按 RERANK_BATCH_SIZE 分批 tokenizer+model。
 * 某批失败则该批退回串行，不整次放弃。
 */
async function scoreCandidates(question: string, texts: string[]): Promise<number[]> {
  const { tokenizer: tok, model: net } = await getReranker();
  const batchSize = rerankBatchSize();
  const scores: number[] = new Array(texts.length);

  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    if (batchSize === 1 || slice.length === 1) {
      scores[i] = await scoreOne(tok, net, question, slice[0]);
      continue;
    }

    try {
      const queries = slice.map(() => question);
      const inputs = tok(queries, {
        text_pair: slice,
        padding: true,
        truncation: true,
        max_length: 512,
      });
      const output = (await net(inputs)) as {
        logits: { tolist: () => unknown; data?: Float32Array | number[] };
      };
      const batchScores = readLogitsBatch(output, slice.length);
      if (batchScores.length !== slice.length) {
        throw new Error(`batch logit 数量不匹配：期望 ${slice.length}，实际 ${batchScores.length}`);
      }
      for (let j = 0; j < slice.length; j++) {
        scores[i + j] = batchScores[j];
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[rerank] batch 失败，本批改串行：${msg}`);
      for (let j = 0; j < slice.length; j++) {
        scores[i + j] = await scoreOne(tok, net, question, slice[j]);
      }
    }
  }

  return scores;
}

/**
 * 对召回候选打重排分，按分从高到低排，再切 keep 条给 prompt。
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

  const texts = candidates.map((hit) => hit.chunk.text);
  const logits = await scoreCandidates(question, texts);

  const ranked: SearchHit[] = candidates.map((hit, index) => ({
    chunk: hit.chunk,
    score: hit.score,
    rerankScore: logits[index],
  }));

  ranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  return {
    rankedAll: ranked,
    injected: ranked.slice(0, keep),
  };
}

/**
 * 启动预热：加载 tokenizer/model + 打一条 dummy 分。
 * 未下载模型时抛错，由 warmup 层处理。
 */
export async function warmRerank(): Promise<void> {
  await scoreCandidates("预热重排", ["这是一段用于预热交叉编码器的短文本。"]);
}
