// ============================================================
// 任务表：上传任务状态的 JSON 持久化（学习 demo 级）
// ============================================================
//
// 干什么：把每条上传任务（KbTask）落到 data/kb/tasks.json，
//         uploader 建任务、worker 认领/推进状态、列表页读全量都走这里。
//
// 为什么这样持久化（存储策略沿用 server/memory/store.ts 的思路）：
//   - 单文件 JSON：学习期没有数据库，一个文件就是一张表，肉眼可查、可改；
//   - 写入用「临时文件 + rename」原子替换：崩溃时磁盘上要么旧版要么新版，
//     不会出现写一半的半个 JSON（读到半截会毁掉整张表）；
//   - 全部写操作走进程内串行锁：多个并发请求排队执行，不互相覆盖；
//   - 文件缺失 / 损坏一律降级为空任务表：服务不因数据文件坏掉而崩。
//
// 状态推进规则由 worker 调用 updateTask / claim* 完成，
// 本文件只保证「读写不丢、并发不撞」，不掺业务判断。

// 导入：mkdir 建 data/kb 目录、readFile 读任务表、rename 原子替换、writeFile 写临时文件
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// path：拼 data/kb/tasks.json 的绝对路径
import path from "node:path";
// 类型与校验：KbTask 是任务记录、KbTaskStatus 是状态枚举、isValidKbTask 过滤坏记录
import { isValidKbTask, type KbTask, type KbTaskStatus } from "./types.js";

// 任务表目录：项目根下 data/kb/（data/ 已 gitignore，不污染版本库）
const KB_DIR = path.join(process.cwd(), "data", "kb");

// 任务表文件路径：data/kb/tasks.json
const TASKS_FILE = path.join(KB_DIR, "tasks.json");

// 进程内串行锁：所有读改写按到达顺序排队（Promise 链实现）
let lock: Promise<void> = Promise.resolve();

// ------------------------------------------------------------
// 私有工具：任务 id 生成 / 锁内读写
// ------------------------------------------------------------

/**
 * 生成任务 id：kb_{timestamp}_{random}。
 * 时间戳保证肉眼可排序，随机段保证并发创建也不撞。
 */
function createTaskId(now: number): string {
  // 随机段取 6 位 base36（0-9a-z），同一毫秒内也几乎不会重复
  const random = Math.random().toString(36).slice(2, 8);
  // 拼成 kb_{时间戳}_{随机串}
  return `kb_${now}_${random}`;
}

/**
 * 在串行锁内执行一段任务（Promise 链实现，单进程内有效）。
 * 为什么：异步读改写之间如果插入别的操作，会互相覆盖对方写回的结果；
 *         用「前一个完成的 Promise 链」排队，保证同一时刻只有一个操作在读写。
 */
async function withLock<T>(task: () => Promise<T>): Promise<T> {
  // 记下当前锁链尾部（上一个还没完成的操作）
  const previous = lock;
  // 新造一个「完成后释放」的 Promise，接到锁链尾部，让自己排队
  let release: () => void = () => {};
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 等前面所有操作完成（前一个出错也不阻断，catch 吞掉，保证锁链不中断）
  await previous.catch(() => undefined);
  try {
    // 轮到自己的时候才执行真正的逻辑
    return await task();
  } finally {
    // 无论成败都释放锁，下一个排队者才能开始
    release();
  }
}

/**
 * 读任务表（不加锁，供锁内调用）。
 * 文件缺失或损坏都返回空数组——降级策略，服务不因数据文件坏掉而崩。
 */
async function readTasksUnlocked(): Promise<KbTask[]> {
  // 先读原始文本；文件不存在（首次运行）按空表处理
  let raw: string;
  try {
    raw = await readFile(TASKS_FILE, "utf-8");
  } catch {
    return [];
  }
  try {
    // 解析 JSON；顶层必须是数组，否则视为损坏
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("任务表顶层不是数组");
    // 只保留形状合法的任务记录，坏记录直接丢掉
    return parsed.filter(isValidKbTask);
  } catch {
    // 损坏时重置为空并打日志（和块表 / 向量表策略一致）
    console.warn("[kb] 任务表文件损坏，重置为空");
    await writeTasksUnlocked([]);
    return [];
  }
}

/**
 * 原子写入任务表（不加锁，供锁内调用）。
 * 先写 .tmp 再 rename：rename 是原子替换，崩溃也只见旧版或新版。
 */
async function writeTasksUnlocked(tasks: KbTask[]): Promise<void> {
  // 目录可能不存在（首次运行），先确保存在
  await mkdir(KB_DIR, { recursive: true });
  // 临时文件路径：同目录 .tmp 后缀（跨目录 rename 可能失败）
  const tmpPath = `${TASKS_FILE}.tmp`;
  // 先写完整内容到临时文件（人读数据，保留 2 空格缩进）
  await writeFile(tmpPath, JSON.stringify(tasks, null, 2), "utf-8");
  // 原子替换成正式文件
  await rename(tmpPath, TASKS_FILE);
}

// ------------------------------------------------------------
// 对外 API：列表 / 创建 / 查询 / 认领 / 更新 / 删除 / 重试
// ------------------------------------------------------------

/**
 * 列出全部任务，按创建时间倒序（新的在前）——任务列表页直接消费。
 */
export async function listTasks(): Promise<KbTask[]> {
  // 进锁：读 + 排序与写操作要串行，避免读到写一半的状态
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 按创建时间从新到旧排序（列表页不翻页就是最新到最旧）
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  });
}

/**
 * 创建一条排队中的任务。
 *
 * 为什么这样设计：
 *   - 同「分类 + 文件名」复用同一 docId：docId 是替换单位，
 *     新版上传覆盖旧版（块/向量按 docId 整篇替换），不产生第二篇同文文档；
 *   - 但每次上传都生成新任务 id：每一条上传动作都有独立记录，
 *     列表页能看到「传了几次、每次状态如何」，而不是被覆盖成一条。
 */
export async function createTask(input: {
  filename: string; // 原始文件名（与分类一起决定 docId 是否复用）
  category: string; // 所属分类（检索硬边界）
}): Promise<KbTask> {
  // 进锁：查旧 docId + 写新任务必须原子，否则并发上传会撞出两个 docId
  return withLock(async () => {
    // 统一取一个「现在」：id 与两个时间戳用同一时刻，保证一致性
    const now = Date.now();
    // 读出当前全部任务
    const tasks = await readTasksUnlocked();
    // 在现有记录里找「同分类 + 同文件名」的旧任务，以复用它的 docId
    const existing = tasks.find(
      (task) => task.category === input.category && task.filename === input.filename,
    );
    // 组装新任务：docId 复用旧的，没有就新造；状态固定 queued，其余字段初始化
    const task: KbTask = {
      // 新任务 id（每次上传都不同，独立记录一次上传动作）
      id: createTaskId(now),
      // 复用旧 docId（同文档换代）或新造一个（全新文档）
      docId: existing?.docId ?? `doc_${now}_${Math.random().toString(36).slice(2, 8)}`,
      // 原始文件名原样存档
      filename: input.filename,
      // 分类存档（后续切片 / 入库 / 检索都带上）
      category: input.category,
      // 新任务一律从排队开始，等 worker 认领
      status: "queued",
      // 还没失败，停点为空
      stage: null,
      // 还没失败，错误为空
      error: null,
      // 还没切片，块数未知
      chunkCount: null,
      // 创建时间 = 现在
      createdAt: now,
      // 最近更新 = 现在（初始状态）
      updatedAt: now,
    };
    // 追加到表尾（数组顺序 = 写入顺序，认领时取最早一条）
    tasks.push(task);
    // 整表原子写回
    await writeTasksUnlocked(tasks);
    // 返回新任务，uploader 拿它去落盘原件
    return task;
  });
}

/**
 * 读取单个任务；不存在返回 null。
 * 测试脚本 / 路由重试前都靠它确认任务当前状态。
 */
export async function getTask(id: string): Promise<KbTask | null> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 按 id 精确查找；找不到返回 null（调用方自行处理）
    return tasks.find((task) => task.id === id) ?? null;
  });
}

/**
 * 原子认领一条 queued 任务（置 chunking 后返回）。
 *
 * 防重入的关键：把「找到」和「标记处理中」放进同一把锁。
 * 另一个循环实例/并发请求再进来时，该任务已不是 queued，不会被重复取走。
 * 取的是任务表里最早的一条（数组顺序 = 写入顺序）。
 */
export async function claimQueuedTask(): Promise<KbTask | null> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 找第一条还在排队的任务（写入顺序 = 先来先服务）
    const index = tasks.findIndex((task) => task.status === "queued");
    // 没有可认领的返回 null，worker 这轮空转
    if (index === -1) return null;
    // 认领 = 置 chunking 并刷新时间戳（写回后别人就取不到了）
    tasks[index] = { ...tasks[index], status: "chunking", updatedAt: Date.now() };
    // 原子写回
    await writeTasksUnlocked(tasks);
    // 返回认领后的任务（已带 chunking 状态）
    return tasks[index];
  });
}

/**
 * 原子认领一条 chunked 任务（置 embedding 后返回）。
 *
 * 步骤 5 的入库入口：块已经落库、等待向量化。与 claimQueuedTask 同一套
 * 「找到 + 标记处理中」放进一把锁的防重入写法，循环实例不会重复取走。
 */
export async function claimChunkedTask(): Promise<KbTask | null> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 找第一条等入库的任务（已切好块的）
    const index = tasks.findIndex((task) => task.status === "chunked");
    // 没有可认领的返回 null，worker 这轮空转
    if (index === -1) return null;
    // 认领 = 置 embedding 并刷新时间戳
    tasks[index] = { ...tasks[index], status: "embedding", updatedAt: Date.now() };
    // 原子写回
    await writeTasksUnlocked(tasks);
    // 返回认领后的任务
    return tasks[index];
  });
}

/**
 * 更新任务状态字段（状态推进、失败记录、重试复位都走这里）。
 * patch 只允许动这四个字段，身份字段不可变（docId 等由建任务时定死）。
 */
export async function updateTask(
  id: string, // 要更新的任务 id
  patch: Partial<Pick<KbTask, "status" | "stage" | "error" | "chunkCount">>, // 允许更新的字段子集
): Promise<KbTask | null> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 定位目标任务
    const index = tasks.findIndex((task) => task.id === id);
    // 任务不存在返回 null（调用方自行决定是否重试）
    if (index === -1) return null;
    // 合并补丁 + 刷新时间戳（每次状态变更都留痕）
    tasks[index] = { ...tasks[index], ...patch, updatedAt: Date.now() };
    // 原子写回
    await writeTasksUnlocked(tasks);
    // 返回更新后的任务
    return tasks[index];
  });
}

/**
 * 删除某篇文档的全部任务记录（含历史上传的多条）。
 * 删除事务由路由层编排：先删向量/块，再删任务，最后删原件（见步骤 7）。
 */
export async function removeTasksByDoc(docId: string): Promise<void> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 过滤掉该 docId 的所有任务（含历史上传的多条记录）
    const kept = tasks.filter((task) => task.docId !== docId);
    // 剩下的一起写回
    await writeTasksUnlocked(kept);
  });
}

/**
 * 失败任务重试：status 复位为 queued、清空 error/stage，docId 保持不变。
 * 由后台循环重新拾起，从零续跑不重复建文档（见步骤 7 实现要点）。
 */
export async function retryTask(id: string): Promise<KbTask | null> {
  return withLock(async () => {
    // 读出全部任务
    const tasks = await readTasksUnlocked();
    // 找到目标任务；不存在返回 null
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return null;
    // 取出目标任务记录
    const task = tasks[index];
    // 只有 failed 状态才能重试，别的状态重试无意义（防止误调）
    if (task.status !== "failed") {
      throw new Error(`只有 failed 任务可以重试，当前 ${task.status}`);
    }
    // 复位：回 queued、清 error/stage，docId 等身份字段原样保留
    tasks[index] = { ...task, status: "queued", stage: null, error: null, updatedAt: Date.now() };
    // 原子写回
    await writeTasksUnlocked(tasks);
    // 返回复位后的任务
    return tasks[index];
  });
}

// 任务状态集合：worker 按状态取活用（目前以 findIndex 直接判断，保留映射便于扩展）
export const TASK_STATUS: Record<KbTaskStatus, KbTaskStatus> = {
  // 每个状态映射到自身，供需要枚举全部状态的场景使用
  queued: "queued", // 排队中 -> 排队中
  chunking: "chunking", // 切片中 -> 切片中
  chunked: "chunked", // 已切完 -> 已切完
  embedding: "embedding", // 入库中 -> 入库中
  searchable: "searchable", // 可检索 -> 可检索
  failed: "failed", // 失败 -> 失败
};
