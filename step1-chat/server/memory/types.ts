/**
 * 跨会话记忆（Memory）的类型定义。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 * 专项计划：`tasks/memory-plan.md`
 *
 * 这一层是「长期记忆」的线协议，两个形状：
 *
 *   MemoryExtractResult — 抽取器的输出（模型结构化输出的形状，一条候选事实）
 *   MemoryFact         — 落盘的一条事实记忆（存储层的形状，带 id 与生命周期字段）
 *
 * 设计取舍：记忆是**结构化事实**（key/value），不是自由文本摘要。
 *   key 让同一条偏好可以被反复更新而不是堆叠成几十条；
 *   value 让检索可以按语义打分（同一件事的不同说法能被认出来）。
 *
 * 版本约定：结构变了就把 MEMORY_SCHEMA_VERSION + 1。
 * 读到的版本不认识时按「无记忆」处理，不报错、不透传。
 */

/** 记忆文件结构版本号。 */
export const MEMORY_SCHEMA_VERSION = 1;

/** 单个用户最多保留的记忆条数，超出按淘汰规则裁剪。 */
export const MAX_FACTS_PER_USER = 200;

/** 置信度下限：低于这个值的候选事实不落盘（模型「不太确定」的东西不值得记）。 */
export const MIN_CONFIDENCE = 0.6;

/**
 * 检索相似度下限：低于这个值的记忆不注入上下文（无关记忆是噪音，还要占预算）。
 *
 * **0.45 是实测出来的，不是拍脑袋定的。**
 * 用本地 bge-large-zh-v1.5 在 10 组「相关问 ↔ 记忆」+ 7 组「无关问 ↔ 记忆」上量过：
 *
 *   相关对相似度区间 = [0.498, 0.992]
 *   无关对相似度上限 = 0.403
 *   可分离区间       = (0.403, 0.498]
 *
 * 取区间中点 0.45：对无关对留 0.047 余量，对相关对留 0.048 余量，两边对称。
 *
 * 为什么原来那个 0.6 是错的：它落在相关对区间**之外**，
 * 10 组相关对里有 6 组被挡在门外（「这个项目用什么框架」↔「框架: Vue 3 + Vite」
 * 只有 0.569，差 0.03 就被丢掉）。
 * 记忆是抽了、存了、却一轮都没进过上下文——等于白干。
 * 误召回的代价只是多注入一句资料（还有上限 5 条 + 预算裁剪兜底），
 * 漏召回的代价是整个记忆功能形同虚设，两边不对称就该往召回侧偏。
 *
 * 复跑方式：`scripts/check-memory-recall.ts`。
 */
export const SIMILARITY_THRESHOLD = 0.45;

/**
 * 语义合并阈值：两条记忆的语义相似度高于它，才认为是「同一件事的两种说法」。
 *
 * 比检索阈值（0.45）严格得多：
 * 检索时「沾点边」的记忆值得召回给模型看看，
 * 合并时则可能直接删掉一条记忆，误判的代价大得多。
 */
export const SEMANTIC_MERGE_THRESHOLD = 0.85;

/** key 长度上限（语义键很短，超了说明模型在写句子而不是写键）。 */
export const MEMORY_KEY_MAX_LENGTH = 100;

/** value 长度上限（事实值应该是一句话，长的多半是误抽取）。 */
export const MEMORY_VALUE_MAX_LENGTH = 500;

/**
 * 记忆来源分类。
 *
 * `user_explicit_preference` — 用户明确说的偏好（「以后都用中文」）
 * `user_correction`           — 用户纠正了之前的说法（「不对，我用 React」）
 * `project_fact`              — 项目相关的事实（「数据库是 PostgreSQL」）
 * `tool_learned_fact`         — 从工具返回值里学到的配置事实
 *
 * 用 as const 元组而不是普通数组，是为了让它能直接喂给 z.enum()，
 * 类型上仍是同一个 MemorySource。
 */
export const MEMORY_SOURCES = [
  "user_explicit_preference",
  "user_correction",
  "project_fact",
  "tool_learned_fact",
] as const;

/** 来源类型：从元组反推，改元组即改类型。 */
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** 判断一个字符串是不是合法的来源值。 */
export function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === "string" && (MEMORY_SOURCES as readonly string[]).includes(value);
}

/**
 * 匿名用户 ID 的格式：`anon_` 前缀 + 1~64 位字母/数字/下划线/连字符。
 *
 * 前缀是刻意的：记忆数据不应该被误当成「某个真实账号」，
 * 后面这段随机串由前端生成、只存在 localStorage，服务端不采集任何身份信息。
 *
 * 这条规则同时是**路径安全**的闸门——userId 会拼进文件名，
 * 不校验就可能写出 `../../` 之类的路径穿越。
 */
export const MEMORY_USER_ID_PATTERN = /^anon_[A-Za-z0-9_-]{1,64}$/;

/** 判断 userId 是否合法。 */
export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === "string" && MEMORY_USER_ID_PATTERN.test(userId);
}

/**
 * 抽取器的一条候选事实。
 *
 * `shouldStore=false` 时其余字段只用于解释原因（reason），不会落盘。
 * 抽取失败、超时、JSON 非法时抽取器返回空数组，而不是抛异常。
 */
export interface MemoryExtractResult {
  /** 这条事实是否值得跨会话保留。 */
  shouldStore: boolean;
  /** 置信度 0~1；低于 MIN_CONFIDENCE 不落盘。 */
  confidence: number;
  /** 语义键：language / framework / style / db / ... */
  key: string;
  /** 事实值：中文 / Vue 3 / 不使用 emoji / PostgreSQL */
  value: string;
  /** 判断理由（也给前端展示「为什么记住了这条」用）。 */
  reason: string;
  /** 来源分类。 */
  source: MemorySource;
}

/**
 * 落盘的一条记忆事实。
 *
 * 生命周期字段（createdAt / updatedAt / expiresAt / deletedAt）说明一件事：
 * 记忆不是只增不减的日志，它有创建、更新、过期、删除四种状态。
 */
export interface MemoryFact {
  /** 唯一 id，格式 mem_{timestamp}_{random}。 */
  id: string;
  /** 归属的匿名用户。 */
  userId: string;
  /** 语义键。 */
  key: string;
  /** 事实值。 */
  value: string;
  /** 来源分类。 */
  source: MemorySource;
  /** 置信度，落在 [MIN_CONFIDENCE, 1]。 */
  confidence: number;
  /** 创建时间（Unix ms）。 */
  createdAt: number;
  /** 最近更新时间（Unix ms）。 */
  updatedAt: number;
  /** 过期时间（Unix ms）；null 表示永久有效。 */
  expiresAt: number | null;
  /** 同 key 出现了不同值 —— 标记冲突，等待用户在面板里裁决。 */
  conflict?: boolean;
  /** 冲突时保留的候选值（面板里的「用新值」按钮要用它）。 */
  conflictingValue?: string;
  /** 软删除时间（Unix ms）；有值表示这条已被删除，但记录保留以备审计。 */
  deletedAt?: number;
  /** value 的 embedding 缓存，写入时生成，避免检索时重复调用模型。 */
  embedding?: number[];
}

/**
 * 判断一条记忆是否已过期。
 *
 * `expiresAt` 为 null 表示永久有效；否则过了 expiresAt 就算过期。
 * 过期的事实不会出现在检索结果、API 列表里，也不会被重新注入上下文。
 */
export function isFactExpired(fact: MemoryFact, now: number = Date.now()): boolean {
  return typeof fact.expiresAt === "number" && fact.expiresAt <= now;
}

/** 判断一条记忆是否已被软删除。 */
export function isFactDeleted(fact: MemoryFact): boolean {
  return typeof fact.deletedAt === "number";
}

/**
 * 把置信度夹进 [MIN_CONFIDENCE, 1]。
 *
 * 低于下限的一律抬到下限（宁可信其有也别存半信半疑的东西），
 * 高于 1 的压到 1（模型偶尔会给 1.2 这种离谱值）。
 */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return MIN_CONFIDENCE;
  return Math.min(1, Math.max(MIN_CONFIDENCE, value));
}

/**
 * 一条记忆用于向量化的文本。
 *
 * 用 `key: value` 而不是单独的 value：
 * 光看「React」，和问题「我用的什么框架？」语义距离偏远；
 * 带上 key 之后，「framework: React」和问题明显更接近。
 *
 * 这段文本的向量会缓存到 fact.embedding 上，检索时不再重复计算。
 */
export function memoryEmbeddingText(fact: Pick<MemoryFact, "key" | "value">): string {
  return `${fact.key}: ${fact.value}`;
}

/**
 * 把语义键规范化：去空白、去掉结尾冒号、空格换下划线、转小写、超长截断。
 *
 * 键是去重的依据，必须稳定：不规范化的话，
 * 「用 Vue」和「用 vue」会变成两条记忆，去重就失效了。
 *
 * 放在这一层（而不是抽取器里）是因为 API 写入的记忆也要走同一套规范化，
 * 否则「手动加的一条」和「抽出来的一条」会互相认不出来。
 */
export function normalizeKey(key: string): string {
  return key
    .trim()
    .replace(/[:：]\s*$/, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .slice(0, MEMORY_KEY_MAX_LENGTH);
}

/**
 * 记忆相关的 SSE 事件（走 onTrace → 前端过程面板）。
 *
 * 三个事件对应记忆链路的三种结果：
 * - memory_injected：这轮往上下文里放了几条记忆
 * - memory_extracted：这轮从对话里存下了什么
 * - memory_failed：记忆链路某一步挂了（不影响聊天）
 *
 * 之所以把它们放进 trace 而不是单独开一条 SSE 通道：
 * 记忆本来就是「过程」的一部分，和压缩、检索放在一起看最自然。
 */
export type MemoryTraceEvent =
  | {
      type: "memory_injected";
      /** 实际注入的记忆 id（按相似度从高到低）。空数组 = 这轮没注入。 */
      itemIds: string[];
      /** 记忆层占用的估算 token。 */
      tokens: number;
      /**
       * 本轮真正注入的明细（预算裁剪后留下来的那几条）。
       *
       * 没有这个字段时前端只知道「注入了几条」，不知道「注入的什么」；
       * 面板要展示 key/value/相似度，就靠这份明细。
       */
      items?: MemoryInjectedItem[];
    }
  | {
      type: "memory_extracted";
      /** 模型给出的候选条数。 */
      candidates: number;
      /** 真正落盘（或更新）的条目。 */
      stored: { id: string; key: string; value: string }[];
    }
  | {
      type: "memory_failed";
      /** 失败发生在哪一步。 */
      stage: "retrieve" | "extract" | "store";
      /** 失败原因（人可读）。 */
      message: string;
    };

/**
 * 注入事件里的一条明细。
 *
 * 与 ContextMemoryItem 同形：id + key + value + 相似度。
 * 前端用它渲染「这一轮给模型塞了哪几条记忆」。
 */
export interface MemoryInjectedItem {
  /** 记忆条目的稳定 id。 */
  id: string;
  /** 语义键，例如 language / framework。 */
  key: string;
  /** 事实值，例如 中文 / Vue 3。 */
  value: string;
  /** 与本轮问题的相似度。 */
  similarity: number;
}
