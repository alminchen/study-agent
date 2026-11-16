/** RAG 切分结果：入库前每条 chunk 必须带齐来源字段 */

import type { KbRouteMeta, MultiQueryMeta, HydeMeta, RewriteMeta } from "./queryEnhance/types.js";

export interface DocumentChunk {
  /** 稳定 id，例如 notes-chunk-3 */
  id: string;
  /** 文件名，如 stage3-rag-notes.md */
  source: string;
  /** 所属标题（没有标题时为空字符串） */
  title: string;
  /** 块正文（通常以标题开头，便于单独阅读） */
  text: string;
  /** 从 0 开始的序号 */
  seq: number;
}

export interface ChunkOptions {
  /** 单块最大字符数（按 JS 字符串 length，中文约等于字数） */
  maxChars?: number;
  /** overlap 占 maxChars 的比例，建议 0.1～0.2 */
  overlapRatio?: number;
}

/** 入库后的一条记录：向量 + 原文 + 来源，三件套缺一不可。 */
export interface StoredChunk {
  id: string;
  source: string;
  title: string;
  text: string;
  seq: number;
  embedding: number[];
  /**
   * 可选：来源分类（步骤 4 合并动态知识库时冗余写入，步骤 5 前端展示分类标签用）。
   * 离线 notes 的块没有此字段，保持 undefined，前端据此区分两套来源的展示方式。
   */
  category?: string;
}

export interface SearchHit {
  chunk: StoredChunk;
  /** 向量余弦，召回排序用 */
  score: number;
  /** 交叉编码器打分，重排后才有 */
  rerankScore?: number;
}

/**
 * 检索后的空结果判断。
 *
 * empty=true 不代表 search 没返回行：rawHits 仍是原始 TopK。
 * hits 才是允许注入 prompt 的列表；判空时为空，避免把低分噪声塞给模型。
 * 分数低于门槛但 Top1 标题对上问句时，empty 仍为 false（见 retrieve.ts）。
 */
export interface RetrievalJudgment {
  empty: boolean;
  /** 注入 prompt 的块：有资料时是重排后的 TopK */
  hits: SearchHit[];
  /** 向量召回候选（未重排），判空后仍保留 */
  rawHits: SearchHit[];
  /** 对全部候选按重排分排好的列表；判空时没有 */
  rankedAll: SearchHit[];
  topScore: number | null;
  message?: string;
  /**
   * 检索前问句增强元数据（单元 4）。
   * UI 仍显示用户原句；embed / 闸门标题比对 / 重排用的是 meta.queryUsed。
   */
  rewriteMeta?: RewriteMeta;
  /** 多库路由元数据（单元 5）；硬过滤用 sourcesAllowed */
  kbRouteMeta?: KbRouteMeta;
  /** 多路召回元数据（单元 6） */
  multiQueryMeta?: MultiQueryMeta;
  /** HyDE 假文档检索元数据（单元 7） */
  hydeMeta?: HydeMeta;
}
