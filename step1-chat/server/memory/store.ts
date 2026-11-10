/**
 * 记忆存储层：按用户分文件的 JSON 持久化。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 * 专项计划：`tasks/memory-plan.md`
 *
 * 存储策略（学习 demo 级，和 server/usage/store.ts 一个量级）：
 *   - 每个用户一个文件：data/memory/<anon_xxx>.json（data/ 已在 .gitignore 里）
 *   - 写入用「临时文件 + rename」，rename 在同一文件系统上是原子替换，
 *     所以不会出现「写到一半被读走」的半个 JSON
 *   - 同一用户的写操作走进程内串行锁，并发请求不会互相覆盖
 *   - 读失败、文件损坏、目录不存在一律降级成「空记忆」，绝不抛给聊天主链路
 *
 * 生产环境应换 SQLite / Postgres，本模块不做那层。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultMemoryEmbedder } from "./embedder.js";
import {
  ensureEmbeddings,
  mergeIncomingFact,
  mergeIncomingFacts,
  type MergeOptions,
} from "./merge.js";
import {
  MAX_FACTS_PER_USER,
  clampConfidence,
  isFactDeleted,
  isFactExpired,
  isMemorySource,
  isValidUserId,
  type MemoryFact,
  type MemorySource,
} from "./types.js";

/** 记忆文件目录：项目根下的 data/memory/。 */
const MEMORY_DIR = path.join(process.cwd(), "data", "memory");

/**
 * 每个用户一把串行锁。
 *
 * 用 Promise 链实现：后到的写操作排在先到的后面，
 * 这样「读 → 合并 → 写」这三步不会被另一个请求插进来。
 *
 * 只在单进程内有效——这个 demo 服务就是单进程 Node，
 * 真要多进程部署得换成文件锁（proper-lockfile）或数据库事务。
 */
const userLocks = new Map<string, Promise<void>>();

/** 在用户锁内执行一段任务，保证同一用户的读改写不互相穿插。 */
async function withUserLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  userLocks.set(userId, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (userLocks.get(userId) === tail) userLocks.delete(userId);
  }
}

/**
 * 拼出某个用户的记忆文件路径。
 *
 * userId 会直接进文件名，所以这里必须先校验格式：
 * `../../etc/passwd` 这种输入会让路径跳出 data/memory/。
 */
export function resolveMemoryPath(userId: string): string {
  if (!isValidUserId(userId)) {
    throw new Error(`非法的 userId：${JSON.stringify(userId)}`);
  }
  return path.join(MEMORY_DIR, `${userId}.json`);
}

/**
 * 判断磁盘上的一条记录是不是结构完整的记忆事实。
 *
 * 磁盘文件是外部可写的数据（也可能被手工改坏），
 * 所以每条记录都要过一遍形状校验，坏的就当没有。
 */
function isValidFactShape(value: unknown): value is MemoryFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Partial<MemoryFact>;
  return (
    typeof fact.id === "string" &&
    typeof fact.userId === "string" &&
    typeof fact.key === "string" &&
    typeof fact.value === "string" &&
    isMemorySource(fact.source) &&
    typeof fact.confidence === "number" &&
    typeof fact.createdAt === "number" &&
    typeof fact.updatedAt === "number" &&
    (fact.expiresAt === null || typeof fact.expiresAt === "number")
  );
}

/**
 * 淘汰超出上限的记忆。
 *
 * 规则：先淘汰置信度低的，同置信度再淘汰最久没更新的。
 * 排序用「升序取前 N 条保留」实现，逻辑等价但不用先排再截。
 */
function pruneFacts(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length <= MAX_FACTS_PER_USER) return facts;
  return [...facts]
    .sort((a, b) => a.confidence - b.confidence || a.updatedAt - b.updatedAt)
    .slice(0, MAX_FACTS_PER_USER);
}

/** 生成记忆 id：mem_{timestamp}_{random}。 */
function createFactId(now: number): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `mem_${now}_${random}`;
}

/**
 * 构造一条新的记忆事实（还没落盘）。
 *
 * 抽取器和 API 都用它来生成待写入的事实，
 * 保证 id、时间戳、置信度夹取这些规则只有一处实现。
 */
export function createMemoryFact(input: {
  userId: string;
  key: string;
  value: string;
  source: MemorySource;
  confidence: number;
  expiresAt?: number | null;
  embedding?: number[];
}): MemoryFact {
  const now = Date.now();
  const fact: MemoryFact = {
    id: createFactId(now),
    userId: input.userId,
    key: input.key,
    value: input.value,
    source: input.source,
    confidence: clampConfidence(input.confidence),
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt ?? null,
  };
  if (input.embedding) fact.embedding = input.embedding;
  return fact;
}

/** 读原始文件内容并解析（不加锁，供锁内调用）。 */
async function readMemoryUnlocked(userId: string): Promise<MemoryFact[]> {
  const filePath = resolveMemoryPath(userId);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    // 边界 1：文件不存在 —— 第一次访问是正常路径，直接返回空。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn("[memory] 读取记忆文件失败，按空记忆处理", { userId, error });
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("记忆文件顶层不是数组");
    return parsed.filter(isValidFactShape);
  } catch (error) {
    // 边界 2：JSON 语法错误 —— 记录错误、把文件重置成空数组、返回空记忆。
    // 重置是为了不让一个坏文件反复报错；聊天主链路完全不受影响。
    console.warn("[memory] 记忆文件已损坏，重置为空", { userId, error });
    await writeMemoryUnlocked(userId, []);
    return [];
  }
}

/** 原子写入（不加锁，供锁内调用）。 */
async function writeMemoryUnlocked(userId: string, facts: MemoryFact[]): Promise<void> {
  // 边界 3：目录不存在 —— 自动创建（mkdir recursive 遇到已存在也不报错）。
  await mkdir(MEMORY_DIR, { recursive: true });
  const filePath = resolveMemoryPath(userId);
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(pruneFacts(facts), null, 2);
  await writeFile(tmpPath, payload, "utf-8");
  // rename 在同一文件系统上是原子替换：读到的要么是旧内容，要么是完整的新内容。
  await rename(tmpPath, filePath);
}

/**
 * 读出某个用户当前**生效**的记忆。
 *
 * 过滤掉两类记录：
 *   软删除的（deletedAt 有值，用户删过）
 *   过期的（expiresAt 已过）
 *
 * 结果按 updatedAt 倒序——最近被确认/更新的记忆排前面。
 */
export async function readMemory(userId: string): Promise<MemoryFact[]> {
  if (!isValidUserId(userId)) return [];
  return withUserLock(userId, async () => {
    const facts = await readMemoryUnlocked(userId);
    const now = Date.now();
    return facts
      .filter((fact) => !isFactDeleted(fact) && !isFactExpired(fact, now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** 读出某个用户磁盘上的全部记忆（含已删除、已过期），供合并时保留历史。 */
export async function readAllFacts(userId: string): Promise<MemoryFact[]> {
  if (!isValidUserId(userId)) return [];
  return withUserLock(userId, () => readMemoryUnlocked(userId));
}

/** 覆盖写入某个用户的全部记忆。 */
export async function writeMemory(userId: string, facts: MemoryFact[]): Promise<void> {
  if (!isValidUserId(userId)) throw new Error(`非法的 userId：${JSON.stringify(userId)}`);
  await withUserLock(userId, () => writeMemoryUnlocked(userId, facts));
}

/**
 * 合并写入若干条新事实，返回合并后的**生效**记忆列表。
 *
 * 整段「读 → 合并 → 写」都在用户锁内完成，
 * 所以并发调用不会丢更新（后写的会基于前一个写完的结果继续合并）。
 */
export async function upsertFacts(
  userId: string,
  newFacts: MemoryFact[],
  options: MergeOptions = {},
): Promise<MemoryFact[]> {
  if (!isValidUserId(userId)) return [];
  if (newFacts.length === 0) return readMemory(userId);

  return withUserLock(userId, async () => {
    const existing = await readMemoryUnlocked(userId);
    const merged = await mergeIncomingFacts(existing, newFacts, options);
    await writeMemoryUnlocked(userId, merged);

    const now = Date.now();
    return merged
      .filter((fact) => !isFactDeleted(fact) && !isFactExpired(fact, now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

/** 单条写入的结果。 */
export interface UpsertFactResult {
  /**
   * 合并后活下来的那一条。
   *
   * 为什么要单独返回：写一条记忆可能撞上三种情况——
   *   1. 全新 key      → 返回刚建的那条
   *   2. 同 key 同值   → 返回被刷新的旧记录（id 不变，updatedAt 变了）
   *   3. 同 key 不同值 → 返回被标记冲突的旧记录
   * 三种情况的 id、createdAt 都不同，API 必须拿到「真正生效的那条」。
   */
  fact: MemoryFact | null;
  /** 合并后该用户全部生效的记忆（按 updatedAt 倒序）。 */
  facts: MemoryFact[];
}

/**
 * 写入**单条**记忆，返回活下来的那一条。
 *
 * 与批量版 upsertFacts 的区别就在返回值：
 * 批量版面向「抽取器一次给一批」的旁路场景，关心的是合并后的全量；
 * 单条版面向 API（用户手动加一条），关心的是「我这次写的那条现在是什么状态」。
 */
export async function upsertFact(
  userId: string,
  newFact: MemoryFact,
  options: MergeOptions = {},
): Promise<UpsertFactResult> {
  if (!isValidUserId(userId)) return { fact: null, facts: [] };
  const embedder = options.embedder ?? defaultMemoryEmbedder;

  return withUserLock(userId, async () => {
    const existing = await readMemoryUnlocked(userId);
    // 语义合并要拿向量比，新事实和没向量的旧事实都得先补上。
    await ensureEmbeddings(existing, [newFact], embedder);
    const outcome = await mergeIncomingFact(existing, newFact, options);
    await writeMemoryUnlocked(userId, outcome.facts);

    const now = Date.now();
    const facts = outcome.facts
      .filter((fact) => !isFactDeleted(fact) && !isFactExpired(fact, now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { fact: outcome.survivor, facts };
  });
}

/** 一条记忆允许被修改的字段。key / userId / source / createdAt 一律不可改。 */
export interface MemoryFactPatch {
  /** 新的事实值。 */
  value?: string;
  /** 新的置信度，落盘前夹进 [MIN_CONFIDENCE, 1]。 */
  confidence?: number;
  /** 新的过期时间；null 表示永久有效。 */
  expiresAt?: number | null;
}

/**
 * 修改一条记忆（只允许改 value / confidence / expiresAt）。
 *
 * 两个容易漏掉的细节：
 *   1. 改了 value 必须丢掉旧的 embedding —— 向量是按旧值算的，
 *      留着它会让检索按旧语义召回，用户看着很怪。
 *   2. 改完要重算冲突标记：同 key 的其它生效记忆里，
 *      值不同的那条就是冲突方；没有冲突方时要把冲突标记清掉。
 *
 * 找不到、或不属于该用户时返回 null（不区分这两者，避免泄露别人的 id 是否存在）。
 */
export async function updateFact(
  userId: string,
  factId: string,
  patch: MemoryFactPatch,
): Promise<MemoryFact | null> {
  if (!isValidUserId(userId)) return null;

  return withUserLock(userId, async () => {
    const facts = await readMemoryUnlocked(userId);
    const target = facts.find((fact) => fact.id === factId && fact.userId === userId);
    if (!target || isFactDeleted(target)) return null;

    const now = Date.now();
    const next: MemoryFact = { ...target, updatedAt: now };

    /**
     * 用户显式提交了 value = 一次「裁决」，不是一次「改值」。
     *
     * 面板上的三个按钮（保留当前 / 用新值 / 合并）全都走这一条路：
     * 三个按钮提交的都是 value，所以服务端没法靠 value 的内容区分它们，
     * 只能统一按「用户已经拍板」处理——清掉冲突标记，同 key 只留这一条。
     */
    const explicitValue = typeof patch.value === "string";

    if (typeof patch.value === "string" && patch.value !== target.value) {
      next.value = patch.value;
      delete next.embedding;
    }
    if (typeof patch.confidence === "number") {
      next.confidence = clampConfidence(patch.confidence);
    }
    if (patch.expiresAt !== undefined) {
      next.expiresAt = patch.expiresAt;
    }

    // 同 key 的其它生效记忆（正常流程下为空：同 key 的事实写入时就合并了）。
    const sameKeyOthers = facts.filter(
      (fact) =>
        fact.id !== target.id && fact.key === next.key && !isFactDeleted(fact),
    );

    if (explicitValue) {
      // 裁决完成：冲突标记清掉，同 key 的其它记录退场（软删除，可审计）。
      delete next.conflict;
      delete next.conflictingValue;
    } else {
      // 冲突重算，分两种情况：
      //   1. 同 key 的其它生效记忆里，值不同的那条就是冲突方（兜底）。
      //   2. 这条自己还带着「待选值」（conflictingValue）且没被裁决掉：
      //      说明冲突还在，标记和待选值都要留着。
      const rival = sameKeyOthers.find(
        (fact) => !isFactExpired(fact, now) && fact.value !== next.value,
      );
      if (rival) {
        next.conflict = true;
        next.conflictingValue = rival.value;
      } else if (next.conflictingValue !== undefined && next.conflictingValue !== next.value) {
        next.conflict = true;
      } else {
        delete next.conflict;
        delete next.conflictingValue;
      }
    }

    const updated = facts.map((fact) => {
      if (fact === target) return next;
      // 裁决后同 key 只保留被裁决的那一条，避免面板出现重复行。
      if (explicitValue && sameKeyOthers.includes(fact)) {
        return { ...fact, deletedAt: now, updatedAt: now };
      }
      return fact;
    });
    await writeMemoryUnlocked(userId, updated);
    return next;
  });
}

/**
 * 回写事实的 embedding 缓存。
 *
 * 检索时发现某条旧记忆没有向量，就现场算一次再存回来，
 * 下次检索就不用再算了。写入只碰 embedding 字段，不动其他内容。
 */
export async function persistEmbeddings(
  userId: string,
  embeddings: Map<string, number[]>,
): Promise<void> {
  if (!isValidUserId(userId)) return;
  if (embeddings.size === 0) return;

  await withUserLock(userId, async () => {
    const facts = await readMemoryUnlocked(userId);
    const updated = facts.map((fact) => {
      const vector = embeddings.get(fact.id);
      return vector ? { ...fact, embedding: vector } : fact;
    });
    await writeMemoryUnlocked(userId, updated);
  });
}

/**
 * 软删除一条记忆。
 *
 * 只写 deletedAt，不真的删记录——用户「删掉了什么」本身也是可审计的事实。
 * 找不到（或不属于该用户）时返回 null。
 */
export async function deleteFact(
  userId: string,
  factId: string,
): Promise<MemoryFact | null> {
  if (!isValidUserId(userId)) return null;

  return withUserLock(userId, async () => {
    const facts = await readMemoryUnlocked(userId);
    const target = facts.find((fact) => fact.id === factId && fact.userId === userId);
    if (!target || isFactDeleted(target)) return null;

    const deletedAt = Date.now();
    const updated = facts.map((fact) =>
      fact === target ? { ...fact, deletedAt, updatedAt: deletedAt } : fact,
    );
    await writeMemoryUnlocked(userId, updated);
    return { ...target, deletedAt, updatedAt: deletedAt };
  });
}

/** 清空某个用户的全部记忆，返回被清掉的条数。 */
export async function clearMemory(userId: string): Promise<number> {
  if (!isValidUserId(userId)) return 0;

  return withUserLock(userId, async () => {
    const facts = await readMemoryUnlocked(userId);
    const count = facts.filter((fact) => !isFactDeleted(fact)).length;
    await writeMemoryUnlocked(userId, []);
    return count;
  });
}
