// ============================================================
// 块存储：切成块后的文本记录，持久化到 data/kb/chunks.json
// ============================================================
//
// 干什么：worker 切片后把「块文本」交给这里落盘；前端块预览、
//         入库取材、列表块数统计都读它。
//
// 为什么块和向量分两个文件存：
//   - 块是「人可读」的一层，向量是「机器可算」的一层；
//   - 块预览不需要向量，而向量表每条带 1024 维数据、大而笨重，
//     只为看文本去读它太浪费；
//   - 两个文件各自独立替换，正好对应状态机的两个节点：
//     「切片完成」（chunked，块已落库）与「可检索」（searchable，向量已写入）。
//
// 与任务表同一套模式：进程内串行锁 + 临时文件原子替换。
// 替换语义：同 docId 再次切片先清旧块再写新块，打底「重复上传不混版」。

// 导入：mkdir 建目录、readFile 读块表、rename 原子替换、writeFile 写临时文件
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// path：拼 data/kb/chunks.json 的绝对路径
import path from "node:path";
// DocumentChunk 是切片器产出的块形状（id/source/title/text/seq）
import type { DocumentChunk } from "../rag/types.js";

// ------------------------------------------------------------
// 块记录类型
// ------------------------------------------------------------

/**
 * 入库前的一块：在 DocumentChunk 基础上冗余 docId / category。
 * 为什么冗余：检索/统计时直接按它们过滤，不用回查任务表拼装（少一次 join）。
 */
export interface KbChunk extends DocumentChunk {
  // 文档身份：这一块属于哪篇文档（替换单位，同 docId 的块整篇换代）
  docId: string;
  // 分类：检索硬边界，冗余存储，检索时直接按它过滤（步骤 6）
  category: string;
}

// 块表目录与文件路径（与任务表、向量表同处 data/kb/）
const KB_DIR = path.join(process.cwd(), "data", "kb");
const CHUNKS_FILE = path.join(KB_DIR, "chunks.json");

// 进程内串行锁：与 taskStore 同款 Promise 链，读改写按到达顺序排队
let lock: Promise<void> = Promise.resolve();

/**
 * 在串行锁内执行一段任务（单进程内有效），防止并发替换互相覆盖。
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
 * 磁盘记录形状校验：字段缺失/类型不对的坏块当不存在。
 * 为什么：块表是持久化文件，一条坏块不挡在这里，列表/入库就会拿脏数据。
 */
function isValidKbChunk(value: unknown): value is KbChunk {
  // 非对象 / null 直接排除
  if (typeof value !== "object" || value === null) return false;
  // 转成 Partial 后逐字段验证
  const chunk = value as Partial<KbChunk>;
  // 归属字段（id/docId/category/source/title/text）都必须是字符串
  return (
    typeof chunk.id === "string" &&
    typeof chunk.docId === "string" &&
    typeof chunk.category === "string" &&
    typeof chunk.source === "string" &&
    typeof chunk.title === "string" &&
    typeof chunk.text === "string" &&
    // seq 是块内序号，必须是数字（排序依赖）
    typeof chunk.seq === "number"
  );
}

/**
 * 读块文件（锁内调用，不加锁）。
 * 文件缺失 → 空数组；JSON 损坏/顶层不是数组 → 警告并重置为空。
 */
async function readChunksUnlocked(): Promise<KbChunk[]> {
  // 读原始文本；文件不存在当空表
  let raw: string;
  try {
    raw = await readFile(CHUNKS_FILE, "utf-8");
  } catch {
    return [];
  }
  try {
    // 解析 JSON；顶层必须是数组，否则视为损坏
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("块文件顶层不是数组");
    // 只保留形状合法的块
    return parsed.filter(isValidKbChunk);
  } catch {
    // 损坏时重置为空并打日志（和任务表策略一致）
    console.warn("[kb] 块文件损坏，重置为空");
    await writeChunksUnlocked([]);
    return [];
  }
}

/**
 * 原子写块文件（锁内调用）：先写 .tmp 再 rename。
 * rename 是原子替换，崩溃也只见旧版或新版，不会出现写一半的损坏文件。
 */
async function writeChunksUnlocked(chunks: KbChunk[]): Promise<void> {
  // 目录可能不存在（首次运行），先确保存在
  await mkdir(KB_DIR, { recursive: true });
  // 临时文件路径：同目录 .tmp 后缀（跨目录 rename 可能失败）
  const tmpPath = `${CHUNKS_FILE}.tmp`;
  // 先写完整内容到临时文件（人读数据，保留缩进）
  await writeFile(tmpPath, JSON.stringify(chunks, null, 2), "utf-8");
  // 原子替换成正式文件
  await rename(tmpPath, CHUNKS_FILE);
}

// ------------------------------------------------------------
// 对外 API：替换写入 / 按文档读取 / 计数 / 删除
// ------------------------------------------------------------

/**
 * 按「docId」替换整篇文档的块。
 *
 * 干什么：切片完成后把这篇文档的新块整批写入、旧块整批清掉。
 * 为什么：docId 由「分类 + 文件名」复用生成，本身已带分类含义，
 *         按 docId 过滤即等于按「分类 + 文档」定位（见步骤 5 实现要点）。
 * 好处：同一文档再次上传，库里块数永远等于最新一版，旧块不残留不混版。
 */
export async function replaceChunksByDoc(
  docId: string, // 文档身份：以它为单位清旧写新
  category: string, // 分类：冗余进每块，检索时直接过滤
  chunks: DocumentChunk[], // 切片器产出的新块（seq 由切片器编号）
): Promise<void> {
  return withLock(async () => {
    // 读出当前全部块
    const existing = await readChunksUnlocked();
    // 「清旧」：丢掉这篇文档的所有旧块（按 docId 过滤）
    const kept = existing.filter((chunk) => chunk.docId !== docId);
    // 「写新」：给每块补上 docId / category 后追加
    const next: KbChunk[] = [
      ...kept,
      ...chunks.map((chunk) => ({ ...chunk, docId, category })),
    ];
    // 整表原子写回
    await writeChunksUnlocked(next);
  });
}

/**
 * 某篇文档的块（按 seq 排序），供块预览：
 * 人眼确认标题有没有和正文拆开、overlap 参数影响的直观对照。
 */
export async function listChunksByDoc(docId: string): Promise<KbChunk[]> {
  return withLock(async () => {
    // 读出全部块
    const chunks = await readChunksUnlocked();
    // 先按 docId 过滤出这篇文档的块
    return chunks
      .filter((chunk) => chunk.docId === docId)
      // 再按块内序号升序，展示顺序与文档顺序一致
      .sort((a, b) => a.seq - b.seq);
  });
}

/**
 * 某篇文档当前块数（列表页块数统计、入库前取材料都用它）。
 */
export async function countChunksByDoc(docId: string): Promise<number> {
  return withLock(async () => {
    // 读出全部块
    const chunks = await readChunksUnlocked();
    // 数一下这篇文档的块
    return chunks.filter((chunk) => chunk.docId === docId).length;
  });
}

/**
 * 删除某篇文档的全部块（步骤 7 下架事务的第二环：向量清完接着清块）。
 */
export async function removeChunksByDoc(docId: string): Promise<void> {
  return withLock(async () => {
    // 读出全部块
    const chunks = await readChunksUnlocked();
    // 过滤掉这篇文档的全部块，剩下的写回
    await writeChunksUnlocked(chunks.filter((chunk) => chunk.docId !== docId));
  });
}
