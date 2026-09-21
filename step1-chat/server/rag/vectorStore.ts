import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cosine } from "./embedding.js";
import type { SearchHit, StoredChunk } from "./types.js";

/**
 * 落盘路径：项目根下 .chroma/my_notes.json（已 gitignore）。
 *
 * 文件内容是 StoredChunk[]：
 * [{ id, source, title, text, seq, embedding: number[1024] }, ...]
 *
 * 生命周期：
 * 1. load()   启动/入库前读入内存；文件不存在则空库
 * 2. replaceSource / clear  改内存，不立刻写盘
 * 3. save()   整表覆盖写回 JSON（先 mkdir）
 *
 * 同一 source 再次入库必须走 replaceSource，禁止直接 push 造成新旧两版并存。
 */
const STORE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.chroma/my_notes.json",
);

/**
 * 纯 JS 向量库：记录在内存，持久化到 my_notes.json。
 * 阶段 3 用它学通「入库 → TopK」；Chroma 后置。
 */
export class LocalVectorStore {
  private records: StoredChunk[] = [];

  get size(): number {
    return this.records.length;
  }

  /** 从 my_notes.json 读入；文件缺失或坏 JSON 时当作空库。 */
  async load(): Promise<void> {
    try {
      const raw = await readFile(STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as StoredChunk[];
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.records = [];
    }
  }

  /** 把当前内存整表写回 my_notes.json（覆盖写）。 */
  async save(): Promise<void> {
    await mkdir(path.dirname(STORE_PATH), { recursive: true });
    await writeFile(STORE_PATH, JSON.stringify(this.records), "utf8");
  }

  /** 同一 source 不允许新旧两版并存：先删该 source，再写入新块。 */
  replaceSource(source: string, chunks: StoredChunk[]): void {
    this.records = this.records.filter((record) => record.source !== source);
    this.records.push(...chunks);
  }

  clear(): void {
    this.records = [];
  }

  countBySource(source: string): number {
    return this.records.filter((record) => record.source === source).length;
  }

  /** 按余弦相似度取 TopK（分数越高越像）。
   *
   * 单元 5：options.sources 非空时只在这些 source 上比向量（硬过滤）。
   * 传入 [] → 候选池为空（路由 none）；不传 / undefined → 全库。
   */
  search(
    queryVec: number[],
    topK: number,
    options?: { sources?: string[] | null },
  ): SearchHit[] {
    let pool = this.records;
    if (options?.sources != null) {
      const allowed = new Set(options.sources);
      pool = this.records.filter((record) => allowed.has(record.source));
    }
    return pool
      .map((chunk) => ({ chunk, score: cosine(chunk.embedding, queryVec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export function storePath(): string {
  return STORE_PATH;
}
