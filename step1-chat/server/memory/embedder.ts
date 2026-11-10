/**
 * 记忆模块的向量化入口。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 *
 * 为什么要单独抽一层：
 *   1. embedding 走的是本地 bge 模型（`server/rag/embedding.ts`），
 *      那个模块一 import 就会把 ONNX 运行时拉进来。
 *      记忆模块里所有纯逻辑（合并规则、去重、类型）都应该能单独跑，
 *      所以这里用「延迟 import」把它挡在函数内部。
 *   2. 抽成 `MemoryEmbedder` 函数类型后，测试和校验脚本可以注入假向量，
 *      不需要真的加载模型、也不需要网络。
 */

/**
 * 文本 → 向量。传入一组文本，返回同长度的向量数组。
 *
 * 与 `server/rag/embedding.ts` 的 `embed` 同签名，形状对得上。
 */
export type MemoryEmbedder = (texts: string[]) => Promise<number[][]>;

/**
 * 默认实现：调用 RAG 模块的本地 embedding 模型。
 *
 * 用动态 import 的原因写在文件头——静态 import 会让所有记忆相关代码
 * 一上来就背上 ONNX 运行时。
 */
export const defaultMemoryEmbedder: MemoryEmbedder = async (texts) => {
  if (texts.length === 0) return [];
  const { embed } = await import("../rag/embedding.js");
  return embed(texts);
};

/**
 * 余弦相似度。
 *
 * 记忆模块自己算一份，而不复用 `server/rag/embedding.ts` 的 `cosine`，
 * 原因一样：不想为了一个几行函数把 ONNX 运行时拖进来。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
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

/**
 * 判断一个向量是否可用。
 *
 * 零向量（或空数组）不可用：它的余弦相似度恒为 0，
 * 一旦被缓存下来，这条记忆就永远召不回来了——比没有缓存还糟。
 */
export function isUsableVector(vector: number[] | undefined): vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0) return false;
  return vector.some((component) => Number.isFinite(component) && component !== 0);
}

/**
 * 安全的向量化：模型缺失、推理失败、返回条数对不上，统统当作「没有向量」。
 *
 * 记忆是锦上添花的能力，检索不到只是少注入几条上下文，
 * 绝不能因为模型没就绪就让聊天主链路报错。
 */
export async function tryEmbed(
  texts: string[],
  embedder: MemoryEmbedder,
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  try {
    const vectors = await embedder(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      console.warn("[memory] embedding 返回条数不匹配，语义能力降级", {
        expected: texts.length,
        actual: Array.isArray(vectors) ? vectors.length : "非数组",
      });
      return null;
    }
    return vectors;
  } catch (error) {
    console.warn("[memory] embedding 失败，语义能力降级", { error });
    return null;
  }
}
