// ============================================================
// 分类存储：知识库的「分区标签」，持久化到 data/kb/categories.json
// ============================================================
//
// 干什么：维护分类列表（id / name / createdAt）。分类是检索的硬边界
// （步骤 6）：上传必须选一个类、检索必须带一个类，块与向量都按类归属。
//
// 为什么分类要单独一张表而不是硬编码字符串：
//   - 用的人（前端下拉框）要能看到「有哪些类可选」，硬编码改起来要改代码；
//   - 同名去重要有确定语义：同一类名重复建类返回同一个 id，
//     否则「同一个名字」会裂成两个检索分区，跨分区问不到东西；
//   - createdAt 给列表倒序（新分类排前面）和审计留痕。
//
// 校验铁律：名字去空白后不能为空——不允许「无名分类」这种脏数据存在。
// 与任务表同一套模式：进程内串行锁 + 临时文件原子替换，坏文件降级为空表。

// 导入：mkdir 建目录、readFile 读分类文件、rename 原子替换、writeFile 写临时文件
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
// path：拼 data/kb/categories.json 的绝对路径
import path from "node:path";

// ------------------------------------------------------------
// 分类记录类型
// ------------------------------------------------------------

/**
 * 一个分类：id 唯一、name 是人类可读名字、createdAt 用于列表倒序。
 */
export interface KbCategory {
  // 分类 id：cat_{时间戳}_{随机数}，一经创建不变（检索/上传按它走）
  id: string;
  // 分类名：去空白后非空，同名去重（重复建返回已有 id）
  name: string;
  // 创建时间（毫秒时间戳），列表按它倒序展示
  createdAt: number;
}

// 分类表目录与文件路径（与任务表、块表、向量表同处 data/kb/）
const KB_DIR = path.join(process.cwd(), "data", "kb");
const CATEGORIES_FILE = path.join(KB_DIR, "categories.json");

// 进程内串行锁：所有读改写按到达顺序排队（防并发建类/列表互相覆盖）
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
 * 磁盘记录形状校验：字段缺失/类型不对的坏分类当不存在。
 * 为什么：列表/去重都按合法记录操作，脏数据混进来会造成
 *         「同名去重失效」或「列表页出现空名字」。
 */
function isValidCategory(value: unknown): value is KbCategory {
  // 非对象 / null 一律不是合法记录
  if (typeof value !== "object" || value === null) return false;
  // 转成 Partial 后逐字段验证
  const category = value as Partial<KbCategory>;
  // id 与 name 必须是字符串
  return (
    typeof category.id === "string" &&
    typeof category.name === "string" &&
    // createdAt 必须是数字（倒序排序依赖）
    typeof category.createdAt === "number"
  );
}

/**
 * 读分类文件（锁内调用，不加锁）。
 * 文件缺失 → 空数组；JSON 损坏/顶层不是数组 → 警告并重置为空。
 */
async function readCategoriesUnlocked(): Promise<KbCategory[]> {
  // 读原始文本；文件不存在当空表
  let raw: string;
  try {
    raw = await readFile(CATEGORIES_FILE, "utf-8");
  } catch {
    return [];
  }
  try {
    // 解析 JSON；顶层必须是数组，否则视为损坏
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("分类文件顶层不是数组");
    // 只保留形状合法的分类
    return parsed.filter(isValidCategory);
  } catch {
    // 损坏时重置为空并打日志（和其它 kb 存储一致）
    console.warn("[kb] 分类文件损坏，重置为空");
    await writeCategoriesUnlocked([]);
    return [];
  }
}

/**
 * 原子写分类文件（锁内调用）：先写 .tmp 再 rename。
 * rename 是原子替换，崩溃也只见旧版或新版，不会出现写一半的损坏文件。
 */
async function writeCategoriesUnlocked(categories: KbCategory[]): Promise<void> {
  // 目录可能不存在（首次运行），先确保存在
  await mkdir(KB_DIR, { recursive: true });
  // 临时文件路径：同目录 .tmp 后缀（跨目录 rename 可能失败）
  const tmpPath = `${CATEGORIES_FILE}.tmp`;
  // 先写完整内容到临时文件（人读数据，保留缩进）
  await writeFile(tmpPath, JSON.stringify(categories, null, 2), "utf-8");
  // 原子替换成正式文件
  await rename(tmpPath, CATEGORIES_FILE);
}

// ------------------------------------------------------------
// 对外 API：列分类 / 建分类（同名去重）
// ------------------------------------------------------------

/**
 * 列出全部分类，按创建时间倒序（新的在前）。
 * 前端下拉框、检索时合法的分类集合都来自这里。
 */
export async function listCategories(): Promise<KbCategory[]> {
  return withLock(async () => {
    // 读出全部分类
    const categories = await readCategoriesUnlocked();
    // 按创建时间倒序：新建的排最前，用户最容易点到
    return categories.sort((a, b) => b.createdAt - a.createdAt);
  });
}

/**
 * 建分类：名字去重（同名返回已有分类，不重复建）。
 * 分类是检索硬边界，多一个同名分类会让替换与过滤产生歧义，必须唯一。
 */
export async function createCategory(name: string): Promise<KbCategory> {
  // 先去空白；空名字没有意义，直接拒绝（提示语面向用户）
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("分类名不能为空");
  }
  return withLock(async () => {
    // 读出当前全部分类
    const categories = await readCategoriesUnlocked();
    // 查重：同名已在表里 → 返回已有记录，不重复建（去重语义）
    const existing = categories.find((category) => category.name === trimmed);
    if (existing) return existing;
    // 造新分类：id 由时间戳 + 随机数拼成，基本不可能撞
    const category: KbCategory = {
      id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: trimmed,
      createdAt: Date.now(),
    };
    // 追加到表尾后整表写回
    categories.push(category);
    await writeCategoriesUnlocked(categories);
    // 返回新分类，调用方拿 id 存档
    return category;
  });
}
