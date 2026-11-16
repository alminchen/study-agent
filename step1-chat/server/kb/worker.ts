// ============================================================
// 后台任务循环：从任务表取活，推进「排队 -> 切片 -> 可检索/失败」
// ============================================================
//
// 干什么：上传只是「收件」，真正的脏活（切片、embedding）都在这条
//         后台循环里干。循环每隔一段时间跑一轮：
//         每轮优先推进新上传（queued 任务切片），没有 queued 就推进
//         已切好的（chunked 任务向量化入库）。
//
// 为什么用「后台循环 + 状态机」而不是「请求里同步干完」：
//   - 上传请求必须秒回（见 uploader），切片/embedding 是慢操作，
//     放请求里会卡住用户；
//   - 状态机记录每步进度，失败能定位到层（read/chunk/embed）、可重试续跑；
//   - 入库「慢慢做」，提问只读 searchable 的完整数据，互不阻塞。
//
// 设计要点（dynamic-kb-execution-plan.md 步骤 3、5）：
//   - 认领即置处理中状态（原子操作），天然防重入——
//     别的循环实例/请求再进来，看到不是 queued/chunked 就不会重复取同一任务；
//   - 每步失败都落 stage + error 到任务上，绝不吞异常让任务永远停在排队；
//   - 入库「全部 embed 完才写盘」，中途失败不落半个文档（见 runEmbedPhase）。

// 读取磁盘原件（切片阶段用）
import { readFile } from "node:fs/promises";
// 拼原件路径
import path from "node:path";
// embedding：把一批文本变成向量（本地 ONNX 模型，见 rag/embedding.ts）
import { embed } from "../rag/embedding.js";
// 切片器：Markdown -> DocumentChunk[]
import { chunkMarkdown } from "../rag/chunker.js";
// 块存储：入库前读取块、切片后替换写入
import { listChunksByDoc, replaceChunksByDoc } from "./chunkStore.js";
// 任务表：认领 queued（切片）、认领 chunked（入库）、更新状态
import { claimChunkedTask, claimQueuedTask, updateTask } from "./taskStore.js";
// 原件目录：拼 原件路径 data/kb/uploads/{docId}/{filename}
import { UPLOAD_DIR } from "./uploader.js";
// 任务类型：worker 处理的对象
import type { KbTask } from "./types.js";
// 向量存储：入库替换、记录类型
import { replaceVectorsByDoc, type KbVectorRecord } from "./vectorStore.js";

// 轮询间隔：学习期 2 秒；观察状态推进够用，也不占资源
const DEFAULT_INTERVAL_MS = 2000;

/**
 * 逐批 embed 的批大小：单批 32 块。
 * 为什么分批：一次塞几百块给 embedding 会一次性打爆内存、也容易触发
 * 服务限流；分批后每批独立完成，大文档也能平稳入库（步骤 5 实现要点）。
 */
const EMBED_BATCH_SIZE = 32;

// 定时器句柄：startKbWorker 用它保证幂等（已有循环不再重复启动）
let timer: NodeJS.Timeout | null = null;
// 忙标志：同一进程内定时器轮询与手动调用互不并发（防两轮抢同一任务）
let busy = false;

/**
 * 切片阶段：处理一条已认领（chunking）的任务。
 * 流程：读磁盘原件 -> chunkMarkdown 切片 -> 替换式写入块表 -> 置 chunked。
 *
 * 失败分两档：
 *   - 原件读不到 -> failed(read)：磁盘文件没了（被删/没落上），卡死原因明确；
 *   - 切片抛错/空结果 -> failed(chunk)：内容问题，提示用户检查文档。
 */
async function runChunkPhase(task: KbTask): Promise<void> {
  // 拼出原件绝对路径：uploads/{docId}/{原始文件名}
  const originalPath = path.join(UPLOAD_DIR, task.docId, task.filename);
  let markdown: string;
  // 第 1 步：读原件。读不到（文件缺失/被删）单独处理，给 readable 的失败原因
  try {
    markdown = await readFile(originalPath, "utf-8");
  } catch (error) {
    // 落在任务上：状态 failed、停点 read、原因带原始错误信息
    const reason = error instanceof Error ? error.message : String(error);
    await updateTask(task.id, {
      status: "failed",
      stage: "read",
      error: `读取原件失败：${reason}`,
    });
    return;
  }

  // 第 2 步：切片 + 落块表。切片抛错与「切不出块」都算失败
  try {
    // 调用切片器，把整篇 Markdown 切成独立可读的块
    const chunks = chunkMarkdown(markdown, task.filename);
    // 空文件/全是垃圾块 → 没有有效内容，直接失败并提示
    if (chunks.length === 0) {
      await updateTask(task.id, {
        status: "failed",
        stage: "chunk",
        error: "没有切出任何有效块（空文件或全是垃圾块）",
      });
      return;
    }
    // 替换式写入块表：同 docId 旧块先清，库里只有最新一版
    await replaceChunksByDoc(task.docId, task.category, chunks);
    // 推进状态：chunked（块可预览），记录块数
    await updateTask(task.id, {
      status: "chunked",
      stage: null,
      error: null,
      chunkCount: chunks.length,
    });
    console.log(`[kb] 任务 ${task.id} 切出 ${chunks.length} 块，等待入库`);
  } catch (error) {
    // 切片器抛错：落 failed(chunk)，绝不静默
    const reason = error instanceof Error ? error.message : String(error);
    await updateTask(task.id, {
      status: "failed",
      stage: "chunk",
      error: `切片失败：${reason}`,
    });
  }
}

/**
 * 入库阶段：处理一条已认领（embedding）的任务。
 * 流程：读块表 -> 逐批 embed -> 替换式写入向量表 -> 置 searchable。
 *
 * 关键设计：全部 embed 完才调 replaceVectorsByDoc 一次写盘。
 * 好处：中途任何一批失败，向量表纹丝不动（不落半个文档），
 *       任务停在 failed(embed)，重试后整篇重新入库，不会新旧残片并存。
 */
async function runEmbedPhase(task: KbTask): Promise<void> {
  try {
    // 第 1 步：从块表读这篇文档的全部块（按 seq 排序，入库顺序稳定）
    const chunks = await listChunksByDoc(task.docId);
    // 块表为空（被删/没切上）→ 没东西可入库，落 failed(embed)
    if (chunks.length === 0) {
      await updateTask(task.id, {
        status: "failed",
        stage: "embed",
        error: "没有可入库的块（块表为空）",
      });
      return;
    }

    // 第 2 步：逐批 embed，攒齐整篇的向量记录
    const records: KbVectorRecord[] = [];
    // 按批大小步进：一次处理 32 块
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      // 切出当前批
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      // 把这一批的块正文一起送入 embedding 模型
      const vectors = await embed(batch.map((chunk) => chunk.text));
      // 块与向量按 index 一一对应，组成向量记录
      batch.forEach((chunk, index) => {
        records.push({
          chunkId: chunk.id, // 与块表一一对应，回查锚点
          docId: task.docId, // 文档身份（替换单位）
          category: task.category, // 分类（检索硬边界）
          source: chunk.source, // 原始文件名（命中结果出处）
          seq: chunk.seq, // 块内序号
          text: chunk.text, // 块正文：命中后直接展示，不回源读文件
          embedding: vectors[index], // 1024 维向量
        });
      });
    }

    // 第 3 步（关键）：全部 embed 完才一次写盘
    // 先删该 docId 旧向量再写新 → 库里永远最新一版
    await replaceVectorsByDoc(task.docId, task.category, records);
    // 推进状态：searchable（可被检索），记录块数 = 入库向量数
    await updateTask(task.id, {
      status: "searchable",
      stage: null,
      error: null,
      chunkCount: records.length,
    });
    console.log(`[kb] 任务 ${task.id} 入库 ${records.length} 条向量，可检索`);
  } catch (error) {
    // embed / 写盘抛错：落 failed(embed)，向量表没动过（因为还没写）
    const reason = error instanceof Error ? error.message : String(error);
    await updateTask(task.id, {
      status: "failed",
      stage: "embed",
      error: `向量化入库失败：${reason}`,
    });
  }
}

/**
 * 跑一轮 worker 轮询。
 * 优先级：先认领 queued（新上传先切片），没有 queued 再认领 chunked
 * （已切好的入库）——保证新文件不会被成堆入库任务饿着。
 * busy 标志防止同一进程里定时器与手动调用并发跑两轮抢同一任务。
 */
export async function runWorkerOnce(): Promise<void> {
  // 上一轮还没结束就直接返回，避免并发抢任务（防重入的第二道防线）
  if (busy) return;
  // 进入忙状态，后面同进程的调用都会被挡下
  busy = true;
  try {
    // 优先认领一条 queued 任务；认领不到返回 null
    const task = await claimQueuedTask();
    if (task) {
      // 有 queued → 跑切片阶段，这轮到此为止
      await runChunkPhase(task);
      return;
    }
    // 没有 queued → 认领一条 chunked 任务跑入库阶段
    const chunkedTask = await claimChunkedTask();
    if (chunkedTask) {
      await runEmbedPhase(chunkedTask);
    }
    // 两者都没有 → 这轮空转，等下一个间隔
  } finally {
    // 无论成败都释放忙标志，下一轮可以开始
    busy = false;
  }
}

/**
 * 启动后台循环（幂等）：立即跑一轮，然后按间隔轮询。
 * timer.unref() 让定时器不阻塞进程退出——服务生命周期外不打扰。
 * server/index.ts 启动时调用一次；测试脚本则手动调 runWorkerOnce 推进。
 */
export function startKbWorker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  // 已有循环就不要再启动一个（防止重复实例抢任务）
  if (timer) return;
  // 启动立即先跑一轮，不等第一个间隔
  void runWorkerOnce();
  // 注册间隔轮询
  timer = setInterval(() => {
    void runWorkerOnce();
  }, intervalMs);
  // 不 hold 住进程：server 退出时定时器不挡路
  timer.unref();
  console.log(`[kb] 后台任务循环已启动（每 ${intervalMs}ms）`);
}
