// ============================================================
// 知识库检索：提问 -> 向量化 -> TopK 命中（分类可选，空 = 全库搜）
// ============================================================
//
// 干什么：把「用户问的一句话」变成向量，在指定分类的向量库里
//         找最相近的若干块，按分数排序返回给前端展示。
//         提问接口签名：ask({ question, category, topK })，见步骤 6 实现要点。
//
// 为什么做成独立模块而不是散在路由里：
//   - 校验（问题/分类非空、topK 范围）只有一处，路由只管接线；
//   - askKnowledge 是「只读库」链路的入口，与上传/入库链路
//     （写链路）在代码上明显分开，正是学习计划「两条链路」的要求；
//   - 将来加重排/过滤只改这里，前端与路由都不用动。
//
// 硬性约束（铁律二、三）：提问侧绝不做整篇切片、绝不 embed 整库——
// 只 embed 提问的第一句话，检索只扫库中已有的向量（searchable 数据）；
// 命中结果带 category 与 source，回答层能看出「来自哪个分类、哪篇文档」。

// embedding：把提问句子变成 1024 维向量（与入库同一个模型/函数）
import { embed } from "../rag/embedding.js";
// 向量存储：按分类检索 / 全库检索 TopK 命中
import { searchAll, searchByCategory } from "./vectorStore.js";

// ------------------------------------------------------------
// 请求 / 响应形状（路由层与前端共享的线协议）
// ------------------------------------------------------------

/** 检索入参：问题、硬边界分类、返回条数。 */
export interface KbAskInput {
  // 用户问的一句话；空问题直接拒绝（没内容可搜）
  question: string;
  // 可选分类：传了只搜这个分类的向量（硬边界），不传/空串则全库搜
  category?: string | null;
  // 返回条数上限，缺省/越界会被收敛到 1..20
  topK?: number;
}

/** 单条命中：原样带分类与来源，第 7 步回答层直接可用。 */
export interface KbAskHit {
  // 命中块所属分类（等于请求里的分类）
  category: string;
  // 来源文件名，如 notes.md（出处展示）
  source: string;
  // 文档身份（调试/删除定位用）
  docId: string;
  // 块内序号（同文档多块时保持顺序）
  seq: number;
  // 块原文，直接展示给用户
  text: string;
  // 与提问的余弦相似度（0~1），分数越高越相关
  score: number;
}

// ------------------------------------------------------------
// 对外 API：提问知识库
// ------------------------------------------------------------

/**
 * 按分类检索 TopK 条候选块。
 * 为什么先校验后干活：question/category 缺一不可，topK 越界会
 * 让检索白忙或返回不完整；先把输入收敛到合法域，再调用底层存储。
 */
export async function askKnowledge(input: KbAskInput): Promise<KbAskHit[]> {
  // 问题必须非空：空串没有语义，直接拒绝
  const question = String(input.question ?? "").trim();
  if (!question) {
    throw new Error("问题不能为空");
  }
  // 分类去空白：有值 = 硬过滤，无值/空串 = 全库搜（不再必填拒绝）
  const category = String(input.category ?? "").trim();
  // topK 收敛到 1..20：缺省给 5，过大返回一堆低分噪音、过小不够看
  const topK = Math.max(1, Math.min(Number(input.topK) || 5, 20));
  // 只 embed 提问这一句（绝不 embed 整库——学习计划铁律二）
  const [queryVec] = await embed([question]);
  // 分支检索：有分类 → 分类内硬过滤；无分类 → 全库扫描（步骤 4 合并式的前置）
  const hits = category
    ? await searchByCategory(category, queryVec, topK)
    : await searchAll(queryVec, topK);
  // 把底层命中（带 record + score）映射成对外形状：丢掉 embedding 大数组
  // （前端不需要 1024 维向量，不返回省流量），字段重命名成前端语义
  return hits.map(({ record, score }) => ({
    category: record.category,
    source: record.source,
    docId: record.docId,
    seq: record.seq,
    text: record.text,
    score,
  }));
}
