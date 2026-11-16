// ============================================================
// 向量存储：块文本 -> 1024 维向量，持久化到 data/kb/vectors.json
// ============================================================
//
// 干什么：worker 把块 embed 成向量后交给这里落盘；检索时按
//         「分类（硬边界）+ 余弦相似度 TopK」取回最相近的块。
//
// 为什么向量和块分开存：
//   - 块是「人可读」的一层，向量是「机器可算」的一层；
//   - 每条向量带 1024 个浮点数，体积是文本的几十倍，检索只扫它不碰文本层；
//   - 两个文件独立替换，正好对应状态机两个节点：chunked（块已落库）与
//     searchable（向量已写入）。
//
// 与块表 / 任务表同一套模式：进程内串行锁 + 临时文件原子替换。
// 文件较大（每条记录含 1024 维向量）所以写盘不缩进；读坏文件降级为空库。
// 替换语义：同 docId 再次入库先删旧向量再写新，库里永远只有最新一版。

// 导入：mkdir 建目录、readFile 读向量文件、rename 原子替换、writeFile 写临时文件
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// path：拼 data/kb/vectors.json 与 .tmp 的路径
import path from "node:path";
// 余弦相似度：检索打分函数，来自 rag/embedding（与入库同一个向量空间）
import { cosine } from "../rag/embedding.js";

// ------------------------------------------------------------
// 向量记录类型
// ------------------------------------------------------------

/**
 * 入库后的向量记录：四元组（category, docId, source, chunkId）决定归属与替换。
 * 为什么冗余这些字段：检索/统计时直接按它们过滤，不用回查块表或任务表（少 join）。
 */
export interface KbVectorRecord {
  // 唯一块 id（与块表一致），检索命中后可直接反查块/文档
  chunkId: string;
  // 文档身份：同分类下同一文件名共用同一 docId（替换单位）
  docId: string;
  // 分类（检索硬边界，搜索时必须带）
  category: string;
  // 原始文件名（第 7 步展示 / 追溯用）
  source: string;
  // 块内序号，按 seq 排序展示
  seq: number;
  // 块正文：命中后直接给用户看，不回源读文件
  text: string;
  // embedding 向量（bge-large-zh-v1.5，1024 维）
  embedding: number[];
}

/**
 * 检索命中项：记录 + 相似度分数（排序与阈值判断都看分数）。
 */
export interface KbVectorHit {
  // 命中的向量记录（含正文与归属信息）
  record: KbVectorRecord;
  // 与提问向量的余弦相似度（0~1），越大越相关
  score: number;
}

// 向量表目录与文件路径（与任务表、块表同处 data/kb/）
const KB_DIR = path.join(process.cwd(), "data", "kb");
const VECTORS_FILE = path.join(KB_DIR, "vectors.json");

// 进程内串行锁：读改写按到达顺序排队，防并发覆盖
let lock: Promise<void> = Promise.resolve();

/**
 * 在串行锁内执行一段任务（Promise 链实现，单进程内有效）。
 */
async function withLock<T>(task: () => Promise<T>): Promise<T> {
  // 记下当前锁链尾部（上一个还没完成的操作）
  const previous = lock;
  // 新造一个「完成后释放」的 Promise，接到锁链尾部，让自己排队
  let release: () => void = () => {};
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 等前面所有操作完成（前一个出错也不阻断，catch 吞掉）
  await previous.catch(() => undefined);
  try {
    // 轮到自己执行真正的逻辑
    return await task();
  } finally {
    // 无论成败都释放，下一个排队者才能开始
    release();
  }
}

/**
 * 磁盘记录形状校验：字段缺失/类型不对的坏向量当不存在。
 * 为什么：向量文件是持久化文件，一条坏记录不挡在这里，
 *         检索就会把垃圾向量当候选，污染结果。
 */
function isValidVectorRecord(value: unknown): value is KbVectorRecord {
  // 非对象 / null 直接排除
  if (typeof value !== "object" || value === null) return false;
  // 转成 Partial 后逐字段验证
  const record = value as Partial<KbVectorRecord>;
  // 身份与文本字段必须是字符串
  return (
    typeof record.chunkId === "string" &&
    typeof record.docId === "string" &&
    typeof record.category === "string" &&
    typeof record.source === "string" &&
    typeof record.seq === "number" &&
    typeof record.text === "string" &&
    // embedding 必须是数组且每个分量都是数字（余弦计算的输入）
    Array.isArray(record.embedding) &&
    record.embedding.every((n) => typeof n === "number")
  );
}

/**
 * 读向量文件（锁内调用，不加锁）。
 * 文件缺失 → 空数组；JSON 损坏/顶层不是数组 → 警告并重置为空。
 */
async function readVectorsUnlocked(): Promise<KbVectorRecord[]> {
  // 读原始文本；文件不存在当空表
  let raw: string;
  try {
    raw = await readFile(VECTORS_FILE, "utf-8");
  } catch {
    return [];
  }
  try {
    // 解析 JSON；顶层必须是数组，否则视为损坏
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("向量文件顶层不是数组");
    // 只保留形状合法的向量记录
    return parsed.filter(isValidVectorRecord);
  } catch {
    // 损坏时重置为空并打日志（和任务表/块表策略一致）
    console.warn("[kb] 向量文件损坏，重置为空");
    await writeVectorsUnlocked([]);
    return [];
  }
}

/**
 * 原子写向量文件（锁内调用）：先写 .tmp 再 rename。
 * rename 是原子替换，崩溃也只见旧版或新版，不会出现写一半的损坏文件。
 * 不缩进（JSON.stringify 不带缩进参数）：向量数组大，空白字符纯属浪费。
 */
async function writeVectorsUnlocked(records: KbVectorRecord[]): Promise<void> {
  // 目录可能不存在（首次运行），先确保存在
  await mkdir(KB_DIR, { recursive: true });
  // 临时文件路径：同目录 .tmp 后缀（跨目录 rename 可能失败）
  const tmpPath = `${VECTORS_FILE}.tmp`;
  // 先写完整内容到临时文件（紧凑格式，不带缩进）
  await writeFile(tmpPath, JSON.stringify(records), "utf-8");
  // 原子替换成正式文件
  await rename(tmpPath, VECTORS_FILE);
}

// ------------------------------------------------------------
// 对外 API：替换写入 / 计数 / 检索 / 删除
// ------------------------------------------------------------

/**
 * 按「docId」整篇替换向量（步骤 5 的检索侧原子操作）。
 * 流程：先删该 docId 的全部旧向量，再把新记录写进去。
 * 为什么：入库是「全部 embed 完才写盘」，这里的替换保证库里向量数
 *         永远等于最新一版；同文档重复上传不会有新旧残片并存。
 */
export async function replaceVectorsByDoc(
  docId: string, // 文档身份：以它为单位清旧写新
  category: string, // 分类：冗余进每条记录，检索时直接过滤
  records: KbVectorRecord[], // 新向量记录（worker 逐批 embed 攒齐后传入）
): Promise<void> {
  return withLock(async () => {
    // 读出当前全部向量
    const existing = await readVectorsUnlocked();
    // 「清旧」：丢掉这篇文档的所有旧向量（按 docId 过滤）
    const kept = existing.filter((record) => record.docId !== docId);
    // 「写新」：给每条记录补全 category 后追加
    const next: KbVectorRecord[] = [
      ...kept,
      ...records.map((record) => ({ ...record, docId, category })),
    ];
    // 整表原子写回
    await writeVectorsUnlocked(next);
  });
}

/**
 * 某篇文档的向量条数（自测 / 列表展示用）。
 */
export async function countVectorsByDoc(docId: string): Promise<number> {
  return withLock(async () => {
    // 读出全部向量
    const records = await readVectorsUnlocked();
    // 数一下这篇文档的向量
    return records.filter((record) => record.docId === docId).length;
  });
}

/**
 * 按分类检索 TopK：先按 category 硬过滤，再按余弦相似度排序。
 * 分类过滤发生在检索层（步骤 6 的硬边界），分数越高越像。
 */
export async function searchByCategory(
  category: string, // 分类硬边界：只在这个分类的向量里找
  queryVec: number[], // 提问向量（调用方已 embed 好的 1024 维）
  topK: number, // 返回条数上限（调用方限制在 1..20）
): Promise<KbVectorHit[]> {
  return withLock(async () => {
    // 读出全部向量
    const records = await readVectorsUnlocked();
    // 第 1 层过滤：只留「这一分类」的候选（硬边界，不参与打分就出局）
    return records
      .filter((record) => record.category === category)
      // 逐个算分数：与提问向量的余弦相似度
      .map((record) => ({ record, score: cosine(record.embedding, queryVec) }))
      // 按分数从高到低排（相似度越高越靠前）
      .sort((a, b) => b.score - a.score)
      // 截取前 topK 条返回
      .slice(0, topK);
  });
}

/**
 * 全库检索 TopK：不做分类过滤，直接对全部记录算余弦（合并式方案的全库扫）。
 * 与 searchByCategory 对称：只差第 1 层过滤，排序/截取逻辑完全一致。
 */
export async function searchAll(
  queryVec: number[], // 提问向量（调用方已 embed 好的 1024 维）
  topK: number, // 返回条数上限（调用方限制在 1..20）
): Promise<KbVectorHit[]> {
  return withLock(async () => {
    // 读出全部向量（不过滤分类，全库都是候选）
    const records = await readVectorsUnlocked();
    // 逐个算分数：与提问向量的余弦相似度
    return records
      .map((record) => ({ record, score: cosine(record.embedding, queryVec) }))
      // 按分数从高到低排（相似度越高越靠前）
      .sort((a, b) => b.score - a.score)
      // 截取前 topK 条返回
      .slice(0, topK);
  });
}

/**
 * 删除某篇文档的全部向量（步骤 7 文档下架时连同块一起清）。
 */
export async function removeVectorsByDoc(docId: string): Promise<void> {
  return withLock(async () => {
    // 读出当前全部向量
    const records = await readVectorsUnlocked();
    // 过滤掉这篇文档的全部向量，剩下的写回
    await writeVectorsUnlocked(records.filter((record) => record.docId !== docId));
  });
}
