/**
 * 检索前问句增强 · 类型（意图 / 扩写）。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 单元 2～5
 *
 * 为何单独 types：
 * - 规则层（parseIntent）与 LLM 层（rewriteQuery）共用同一套 intent 枚举，避免两套字符串对不上
 * - RewriteMeta 挂在 RetrievalJudgment 上给 CLI / SSE 看，不污染 chunk / embedding 结构
 *
 * 路由 / Multi-Query / HyDE：单元 5～7 均已接线；对照时一次只开一个召回增强开关。
 */

/** 粗粒度意图：规则与 LLM 共用。kb_search 表示「像在问资料」，不等于已经搜过库。 */
export type QueryIntent =
  | "weather"
  | "time"
  | "kb_search"
  | "chitchat"
  | "unknown";

/**
 * 单元 5：逻辑知识库路由。
 * - notes / hr_policy：窄库硬过滤
 * - none：跳过检索（与「分数判空」不同，见 message）
 * - all：不过滤（开关关闭或强制全库）
 */
export type KbRoute = "notes" | "hr_policy" | "none" | "all";

export type KbRouteStatus = "ok" | "disabled" | "forced";

/**
 * 路由可解释元数据。
 * sourcesAllowed === null → 不过滤；[] → 候选池为空（none 或映射缺失）。
 */
export interface KbRouteMeta {
  route: KbRoute;
  status: KbRouteStatus;
  /** 允许参与向量比对的 source 文件名；null=全库 */
  sourcesAllowed: string[] | null;
  reason?: string;
}
/**
 * 槽位：从原句拆出的结构化线索。
 * 教学用字段够用即可；不是 NLU 全集。缺的键省略，不要填空字符串凑数。
 */
export interface IntentSlots {
  /** 城市名，如「广州」 */
  city?: string;
  /** 时间线索，如「今天」「现在」 */
  time?: string;
  /** 主题，如「天气」「文档切分」 */
  topic?: string;
}

/**
 * 规则（或归一后）解析结果。
 * source 标明谁产出的，对照实验时能看出「规则命中 vs LLM 覆盖」。
 */
export interface ParsedIntent {
  intent: QueryIntent;
  slots: IntentSlots;
  /** 命中的提示词 / 关键词，便于调试，不直接当 embed 句 */
  keywords: string[];
  /** rule = parseIntent；llm = 仅当将来把 LLM 结果回填为 ParsedIntent 时用 */
  source: "rule" | "llm";
}

/**
 * LLM 扩写成功时的结构化结果（单元 3）。
 *
 * - rewritten：唯一应进入 embed 的自然语言问句（单路）
 * - original 不放这里：由调用方 / RewriteMeta 保留，避免「改写结果里看不到用户原话」
 */
export interface RewriteResult {
  intent: QueryIntent;
  slots: IntentSlots;
  keywords: string[];
  rewritten: string;
}

/**
 * 检索前增强状态机（单元 4）。
 * - disabled：未开 RAG_QUERY_REWRITE，行为与改前一致
 * - ok：扩写成功，queryUsed === rewritten
 * - fallback：扩写失败，queryUsed === original，reason 说明原因
 * - skipped：预留（如 intent=none 跳过检索），本阶段未用
 */
export type RewriteStatus = "ok" | "fallback" | "skipped" | "disabled";

/**
 * 挂在检索结果上的可解释元数据。
 *
 * 红线：
 * - UI / 用户气泡仍显示 original
 * - embed / 闸门标题比对 / 重排用 queryUsed
 * - 没有 meta 就学不会「扩写到底有没有帮忙」
 */
export interface RewriteMeta {
  /** 用户原句 */
  original: string;
  /** 实际用于 embed 的问句（成功时等于 rewritten，否则等于 original） */
  queryUsed: string;
  /** 扩写句；disabled/fallback 时为 null */
  rewritten: string | null;
  intent: QueryIntent | null;
  slots: IntentSlots;
  keywords: string[];
  status: RewriteStatus;
  /** 仅 status=fallback 时有意义 */
  reason?: string;
  /** 扩写前规则预判，便于对照「规则 vs LLM」 */
  ruleIntent?: ParsedIntent | null;
}

/**
 * 单元 6：多路召回可解释元数据。
 * CLI 应能打印 queries 与每路命中概况，否则学不会「多路有没有帮忙」。
 */
export type MultiQueryStatus = "ok" | "disabled" | "skipped";

export interface MultiQueryMeta {
  status: MultiQueryStatus;
  /** 实际参与 embed 的问句列表（已去重，≤3） */
  queries: string[];
  /** 本实现固定 max_score；若将来换 RRF 改此字段 */
  merge: "max_score" | "rrf";
  perQueryHitCounts: number[];
  /** 每路 Top3 id，调试用 */
  perQueryTopIds?: string[][];
  mergedCount: number;
  reason?: string;
}

/**
 * 单元 7：HyDE 可解释元数据。
 * CLI 必须能看见假文档（或截断预览），否则学不会「胡编有没有带偏」。
 */
export type HydeStatus = "ok" | "fallback" | "disabled" | "skipped";

export interface HydeMeta {
  status: HydeStatus;
  /** 用户原句 */
  original: string;
  /** 假想文档全文；disabled/fallback 时为 null */
  hydeDoc: string | null;
  /** 实际用于 embed 的文本（成功=hydeDoc，否则=回退问句） */
  embedText: string;
  reason?: string;
}

