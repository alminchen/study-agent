/** 前端共享类型；结构化部分必须与服务端 structured/types.ts 保持契约一致。 */
export type ChatRole = "user" | "assistant";

/**
 * 前端持久化的图片附件元数据。
 *
 * 与 wire 协议里携带 base64 的完整附件分开：历史记录只存这份元数据，
 * base64 不落 localStorage（隐私），刷新后图片不再回传模型（决策二）。
 */
export interface ChatAttachmentMeta {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * 发送中的图片附件：包含 base64 数据。
 * 只有尚未发送 / 正在发送的用户消息才持有 data；历史里只有 ChatAttachmentMeta。
 */
export interface ChatAttachment extends ChatAttachmentMeta {
  data: string;
  /** 本地预览用 objectURL；仅存在于内存，不持久化。 */
  previewUrl: string;
}

/** 服务端图片校验失败码；与 server/vision/types.ts 同名同义。 */
export type VisionErrorCode =
  | "image_too_large"
  | "image_unsupported_format"
  | "image_invalid_data"
  | "image_dimensions_exceeded"
  | "vision_model_unsupported"
  | "vision_payload_too_large"
  | "vision_provider_rejected";

/**
 * 前端使用的结构化输出线协议类型。
 * 字段需与服务端 server/structured/types.ts 保持一致。
 */
export type StructuredTarget = "table" | "code";

/** 表格 block 的前端展示形状；最终合法性仍以服务端 Zod 校验为准。 */
export interface StructuredTableBlock {
  kind: "table";
  title: string;
  columns: string[];
  rows: string[][];
}

/** 代码 block 的前端展示形状；content 不执行，只按纯文本渲染。 */
export interface StructuredCodeBlock {
  kind: "code";
  title: string;
  language: string;
  content: string;
}

/** 首版只允许 table/code 二选一，禁止任意混合对象直接进入 UI。 */
export type StructuredBlock = StructuredTableBlock | StructuredCodeBlock;

/** 服务端最终校验通过、允许写入历史的结果。 */
export interface StructuredResult {
  schemaVersion: 1;
  block: StructuredBlock;
}

/** 生成过程中的可安全展示快照；它不是最终历史消息。 */
export interface StructuredSnapshot {
  schemaVersion: 1;
  revision: number;
  block: StructuredBlock;
}

export interface StructuredSnapshotEvent {
  /** 与 snapshot.revision 相同，便于 SSE 外层快速去重。 */
  type: "structured_snapshot";
  revision: number;
  snapshot: StructuredSnapshot;
}

export interface StructuredDoneEvent {
  /** done.result 已通过完整 schema，不能再回退成 streaming。 */
  type: "structured_done";
  revision: number;
  result: StructuredResult;
}

/** 前后端共享的六类结构化失败原因。 */
export type StructuredErrorCode =
  | "model_request_failed"
  | "model_stream_interrupted"
  | "partial_parse_failed"
  | "invalid_final_json"
  | "schema_validation_failed"
  | "provider_json_mode_unsupported";

/** 客户端最终拿到的稳定错误；lastRevision 用于保留最后一个安全快照。 */
export interface StructuredClientError {
  code: StructuredErrorCode;
  message: string;
  retryable: boolean;
  lastRevision: number;
}

/** 一条助手消息内的结构化生命周期；partial snapshot 与最终 result 分开保存。 */
export interface StructuredMessageState {
  /** 当前请求目标；重试时沿用同一个 target。 */
  target: StructuredTarget;
  /** streaming/completed/incomplete/error 是前端唯一结果状态机。 */
  status: "streaming" | "completed" | "incomplete" | "error";
  /** 已接受的最大 snapshot 版本，禁止旧事件覆盖新内容。 */
  revision: number;
  /** 生成中的可渲染快照；不进入长期历史。 */
  snapshot: StructuredSnapshot | null;
  /** 最终结果；只有 completed 状态才允许持久化。 */
  result: StructuredResult | null;
  /** error 状态下的稳定错误码，供组件映射文案。 */
  errorCode?: StructuredErrorCode;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** 历史只存元数据；base64 永不落盘。 */
  attachments?: ChatAttachmentMeta[];
  /** 仅资料问答的助手气泡会带：是否判空、有没有调模型、Top1 分数 */
  rag?: RagMeta;
  /** 结构化消息只保存最终结果到历史；生成中的 snapshot 仅存在于内存。 */
  structured?: StructuredMessageState;
}

/** 页面上展示检索闸门结果，不是给模型看的。 */
export interface RagHitView {
  rank: number;
  rerankRank: number | null;
  promptIndex: number | null;
  id: string;
  source: string;
  title: string;
  text: string;
  score: number;
  rerankScore: number | null;
}

/** 检索前问句增强（本课）：只给面板看，不进用户气泡正文 */
export interface RagRewriteMetaView {
  status: string;
  original: string;
  queryUsed: string;
  rewritten: string | null;
  intent: string | null;
  keywords: string[];
  reason?: string;
}

export interface RagKbRouteMetaView {
  status: string;
  route: string;
  sourcesAllowed: string[] | null;
  reason?: string;
}

export interface RagMultiQueryMetaView {
  status: string;
  queries: string[];
  merge: string;
  mergedCount: number;
  reason?: string;
}

export interface RagHydeMetaView {
  status: string;
  hydeDoc: string | null;
  embedText: string;
  reason?: string;
}

export interface RagMeta {
  empty: boolean;
  calledModel: boolean;
  topScore: number | null;
  question: string;
  hits: RagHitView[];
  rewriteMeta?: RagRewriteMetaView | null;
  kbRouteMeta?: RagKbRouteMetaView | null;
  multiQueryMeta?: RagMultiQueryMetaView | null;
  hydeMeta?: RagHydeMetaView | null;
}

/** 自我评估的四维分数（relevance / completeness / groundedness / clarity）。 */
export interface ReflectionScores {
  relevance: number;
  completeness: number;
  groundedness: number;
  clarity: number;
}

/** 一条具体问题；dimension 指明属于哪一维。 */
export interface ReflectionIssue {
  dimension: string;
  detail: string;
}

/**
 * 记忆来源分类；与服务端 memory/types.ts 的 MemorySource 逐值对应。
 */
export type MemorySource =
  | "user_explicit_preference"
  | "user_correction"
  | "project_fact"
  | "tool_learned_fact";

/**
 * 落盘的一条长期记忆；字段与服务端 MemoryFact 同名同义。
 *
 * 前端多一个约束：字段必须与后端对齐，不能自己另发明一套命名，
 * 否则「面板里改的」和「服务端存着的」会对不上。
 */
export interface MemoryFact {
  /** 唯一 id，格式 mem_{timestamp}_{random}。 */
  id: string;
  /** 归属的匿名用户。 */
  userId: string;
  /** 语义键，例如 language / framework。 */
  key: string;
  /** 事实值，例如 中文 / Vue 3。 */
  value: string;
  /** 来源分类。 */
  source: MemorySource;
  /** 置信度，落在 [0.6, 1]。 */
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
  /** value 的 embedding 缓存；前端不用，保留字段是为了与服务端逐字段对齐。 */
  embedding?: number[];
}

export type ToolTraceStep =
  | { kind: "tool_call"; name: string; arguments: unknown }
  | { kind: "tool_result"; name: string; result: unknown }
  | {
      kind: "pending_confirm";
      confirmId: string;
      toolCallId: string;
      name: string;
      arguments: unknown;
      /** pending=等人；resolving=已点按钮等服务端；allow/deny=已结束 */
      status: "pending" | "resolving" | "allow" | "deny";
    }
  | {
      kind: "confirm_resolved";
      toolCallId: string;
      name: string;
      action: "allow" | "deny";
    }
  | { kind: "injection_detected"; level?: string; rules: string[] }
  | {
      kind: "judge_shadow";
      mode: string;
      surface: string;
      guard: { level: string; rules: string[] };
      judge: {
        status: string;
        risk?: string;
        confidence?: number;
        categories?: string[];
        shortReason?: string;
        errorKind?: string;
      };
      meta?: { durationMs?: number; truncated?: boolean };
    }
  | {
      kind: "judge_enforced";
      mode: string;
      surface: string;
      guard: { level: string; rules: string[] };
      judge: {
        status: string;
        risk?: string;
        confidence?: number;
        categories?: string[];
        shortReason?: string;
        errorKind?: string;
      };
      /** 最终动作：allow 放行 / block 拦截 / flag 标记 */
      action: string;
      /** 决策分支标签 */
      label?: string;
      /** 人可读原因 */
      reason?: string;
      /** Judge 与正则结论是否不一致 */
      disagree: boolean;
      meta?: { durationMs?: number; truncated?: boolean };
    }
  | { kind: "output_leak_blocked"; matchedFingerprints: string[] }
  | {
      kind: "reflection_scored";
      /** initial = 初评；revised = 对修订稿的重评。 */
      stage: "initial" | "revised";
      scores: ReflectionScores;
      average: number;
      issues: ReflectionIssue[];
      /** 按阈值算出来的「是否值得重写」，不是模型自说自话。 */
      shouldRewrite: boolean;
      reason: string;
      meta?: { durationMs?: number; attempts?: number; truncated?: boolean };
    }
  | {
      kind: "reflection_revised";
      /** 是否把修订稿作为最终正文；影子模式下恒为 false。 */
      adopted: boolean;
      /** 修订稿均分是否高于初版。 */
      improved: boolean;
      beforeAverage: number;
      afterAverage: number;
      reason: string;
    }
  | {
      kind: "reflection_skipped";
      /** 跳过原因；面板用它解释「为什么没有评分 / 为什么没改」。 */
      reason: string;
      detail: string;
    }
  | {
      kind: "memory_injected";
      /** 本轮注入了几条长期记忆。 */
      count: number;
      /** 记忆层占用的估算 token。 */
      tokens: number;
      /** 注入明细（预算裁剪后真正留下的那几条）。 */
      items: Array<{
        id: string;
        key: string;
        value: string;
        similarity: number;
      }>;
    }
  | {
      kind: "memory_extracted";
      /** 模型给出的候选条数。 */
      candidates: number;
      /** 真正落盘（或更新）的条目。 */
      stored: Array<{ id: string; key: string; value: string }>;
    }
  | {
      kind: "memory_failed";
      /** 失败发生在哪一步。 */
      stage: "retrieve" | "extract" | "store";
      /** 失败原因（人可读）。 */
      message: string;
    }
  | {
      kind: "vision_attachment";
      /** 本轮合法附件张数。 */
      count: number;
      mimeTypes: string[];
      totalBytes: number;
      estimatedImageTokens: number;
    }
  | {
      kind: "vision_rejected";
      code: VisionErrorCode;
      reason: string;
    }
  | {
      kind: "vision_unsupported_model";
      model: string;
    };

/** 单次请求的 token 用量摘要（来自 SSE usage 事件） */
export interface UsageSnapshot {
  endpoint?:
    | "chat"
    | "chat/multi"
    | "rag/chat"
    | "chat/structured"
    | "chat/plan"
    | "chat/reflection";
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  estimatedCostUsd: number;
  /** 无图请求缺省或 0 */
  imageCount?: number;
  imageBytes?: number;
  estimatedImageTokens?: number;
}

/** 单个口径（全部 / 当天）的用量汇总；两个模块字段含义一致。 */
export interface UsageScopeSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byEndpoint: Record<
    string,
    { requests: number; totalTokens: number; costUsd: number }
  >;
  byModel: Record<
    string,
    { requests: number; totalTokens: number; costUsd: number }
  >;
}

export interface UsageSummary extends UsageScopeSummary {
  /** 当天口径的汇总（本地时区当天 00:00 起） */
  today: UsageScopeSummary;
}

export interface ModelOption {
  id: string;
  label: string;
  /** 该模型是否支持图片输入；来自服务端能力判定，前端据此禁用上传入口。 */
  supportsVision?: boolean;
}

/** 模型目录；正常来自 GET /api/models，source 用于区分是否成功读取上游。 */
export interface ModelCatalog {
  models: ModelOption[];
  source: "api" | "fallback";
}

/** 仅在 /api/models 请求失败时兜底，正常列表以接口返回为准。 */
export const FALLBACK_MODEL_OPTIONS: ModelOption[] = [
  { id: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
];

/**
 * 前端 Plan-and-Execute 线协议。
 * 字段需与 server/plan-execute/types.ts 保持同名同义。
 */
export type PlanMode = "auto" | "react" | "plan";

export type PlanToolName =
  | "getWeather"
  | "getCurrentTime"
  | "searchDocs"
  | "draft_message";

export interface PlanStep {
  id: string;
  title: string;
  action: string;
  doneWhen: string;
  tools: PlanToolName[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

/** 前端只关心 code 分支；message 仅用于展示和诊断。 */
export type PlanErrorCode =
  | "classify_failed"
  | "planner_failed"
  | "invalid_plan"
  | "plan_empty"
  | "plan_too_long"
  | "step_turn_limit"
  | "step_tool_limit"
  | "tool_not_allowed"
  | "tool_failed"
  | "confirm_denied"
  | "replan_limit"
  | "model_budget_exhausted"
  | "aborted"
  | "final_reply_failed";

export type PlanRouteReason =
  | "explicit_react"
  | "explicit_plan"
  | "single_step"
  | "multi_capability"
  | "sequential_keywords"
  | "research_then_produce"
  | "artifact_request"
  | "too_ambiguous";

export interface PlanRouteEvent {
  type: "plan_route";
  mode: "react" | "plan";
  reasonCode: PlanRouteReason;
  signals: string[];
}

export interface PlanCreatedEvent {
  type: "plan_created";
  planId: string;
  revision: number;
  plan: Plan;
}

export interface PlanStepStartedEvent {
  type: "plan_step_started";
  planId: string;
  revision: number;
  stepId: string;
  index: number;
  total: number;
}

export interface PlanStepDoneEvent {
  type: "plan_step_done";
  planId: string;
  revision: number;
  stepId: string;
  summary: string;
  toolsCalled: string[];
}

export interface PlanStepFailedEvent {
  type: "plan_step_failed";
  planId: string;
  revision: number;
  stepId: string;
  code: PlanErrorCode;
  message: string;
  retryable: boolean;
}

export interface PlanReplannedEvent {
  type: "plan_replanned";
  planId: string;
  previousRevision: number;
  revision: number;
  reason: string;
  plan: Plan;
}

export interface PlanFinishedEvent {
  type: "plan_finished";
  status: "completed" | "failed" | "aborted";
  completedSteps: number;
  totalSteps: number;
}

export interface PlanFallbackEvent {
  type: "plan_fallback";
  reasonCode: PlanErrorCode;
  message: string;
}

export type PlanEvent =
  | PlanRouteEvent
  | PlanCreatedEvent
  | PlanStepStartedEvent
  | PlanStepDoneEvent
  | PlanStepFailedEvent
  | PlanReplannedEvent
  | PlanFinishedEvent
  | PlanFallbackEvent;

/**
 * 前端维护的步骤状态。
 * 与服务端 PlanStepStatus 同义：前端不能因为收到 done 就自行推断后续步骤成功。
 */
export type PlanStepState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

export interface PlanStepStateView {
  stepId: string;
  status: PlanStepState;
  summary: string;
  toolsCalled: string[];
  errorCode?: PlanErrorCode;
}

/**
 * 一次计划请求的运行时状态。
 *
 * 关键约束：
 * - planId / revision 只增不减，旧事件不得回退状态。
 * - Re-plan 不覆盖旧计划，而是追加到 planHistory。
 * - finished 之后不再接受步骤事件。
 */
export interface PlanRuntimeState {
  planId: string;
  revision: number;
  /** 当前生效的计划；plan_created 之后才有值。 */
  plan: Plan | null;
  /** 历史计划版本，按 revision 顺序追加。 */
  planHistory: Plan[];
  /** 当前版本的步骤状态；Re-plan 后只保留已完成步骤并补上新步骤。 */
  stepResults: PlanStepStateView[];
  route: {
    mode: "react" | "plan";
    reasonCode: PlanRouteReason;
    signals: string[];
  } | null;
  fallback: { reasonCode: PlanErrorCode; message: string } | null;
  /** 计划级失败（如 Re-plan 未被采纳）：与步骤失败分开，保留根因。 */
  planError: { code: PlanErrorCode; message: string } | null;
  finished: boolean;
  finishedStatus: "completed" | "failed" | "aborted" | null;
}

/**
 * 上下文摘要相关类型。
 *
 * 字段必须与服务端 server/context/types.ts **同名同义**：
 * 摘要是前端持久化、服务端校验的线协议，两边字段名不一致就会静默丢数据。
 */

/** 摘要结构版本号；与服务端 CONTEXT_SUMMARY_VERSION 一致。 */
export const CONTEXT_SUMMARY_VERSION = 1;

/** 摘要里的一条普通条目（决定、未决事项、用户约束共用这个形状）。 */
export interface ContextSummaryItem {
  text: string;
  /** 这条内容来自 messages 数组的第几条（原始下标，用于回溯与去重）。 */
  sourceMessageIndex: number;
}

/** 摘要里的一条事实：带 key，方便按 key 更新而不是重复追加。 */
export interface ContextFact {
  key: string;
  value: string;
  sourceMessageIndex: number;
}

/** 结构化上下文摘要：跨轮保留的「早期记忆」。 */
export interface ContextSummary {
  version: number;
  /** 摘要生成时间（毫秒时间戳）。 */
  updatedAt: number;
  /** 摘要覆盖到哪条消息 id（留空表示还没有 id 口径的覆盖范围）。 */
  compactedUntilMessageId: string | null;
  /**
   * 摘要覆盖到 messages 数组的哪一条（含该下标，-1 表示没覆盖任何一条）。
   * 摘要总是从最早的消息开始连续覆盖，所以一个下标就能表达覆盖范围。
   */
  compactedUntilIndex?: number;
  facts: ContextFact[];
  decisions: ContextSummaryItem[];
  unresolved: ContextSummaryItem[];
  /** 用户明确的约束（语言、风格、禁止项），优先级最高。 */
  userConstraints: ContextSummaryItem[];
}

/**
 * SSE 事件 context_compacted 的载荷。
 *
 * 与服务端 server/context/types.ts 的 ContextCompactionEvent 一一对应。
 * 该事件**不带 delta 字段**，所以它永远不会污染回答正文气泡。
 */
export interface ContextCompactionEvent {
  type: "context_compacted";
  /** 本轮被压缩掉的轮数。 */
  compactedRounds: number;
  /** 压缩前这些消息的估算 token。 */
  originalTokens: number;
  /** 压缩后注入的估算 token。 */
  compactedTokens: number;
  /** 摘要本身占的估算 token。 */
  summaryTokens: number;
  /** 摘要不可用、本轮只按预算裁剪。 */
  degraded: boolean;
  /**
   * 本轮生成的新摘要。
   * 摘要失败（degraded=true）时为 null——此时不注入任何摘要，聊天照常继续。
   */
  summary?: ContextSummary | null;
}

/**
 * 校验并规范化一份摘要。
 *
 * 摘要来自 localStorage 或 SSE，都是外部数据，处理原则与服务端一致：
 * - 版本不认识 / 结构不对 → 整份丢弃（等同没有摘要）；
 * - 单条内容不对 → 只丢那一条，其余条目照常保留。
 */
export function normalizeContextSummary(raw: unknown): ContextSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  // 版本不认识说明结构可能变了，硬读只会读出垃圾，直接丢弃。
  if (data.version !== CONTEXT_SUMMARY_VERSION) return null;

  const readItems = (value: unknown): ContextSummaryItem[] => {
    if (!Array.isArray(value)) return [];
    const kept: ContextSummaryItem[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.text !== "string") continue;
      const text = item.text.trim();
      if (!text || typeof item.sourceMessageIndex !== "number") continue;
      kept.push({ text, sourceMessageIndex: item.sourceMessageIndex });
    }
    return kept;
  };

  const readFacts = (value: unknown): ContextFact[] => {
    if (!Array.isArray(value)) return [];
    const kept: ContextFact[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const fact = entry as Record<string, unknown>;
      if (typeof fact.key !== "string" || typeof fact.value !== "string")
        continue;
      const key = fact.key.trim();
      const text = fact.value.trim();
      if (!key || !text || typeof fact.sourceMessageIndex !== "number")
        continue;
      kept.push({
        key,
        value: text,
        sourceMessageIndex: fact.sourceMessageIndex,
      });
    }
    return kept;
  };

  return {
    version: CONTEXT_SUMMARY_VERSION,
    updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : Date.now(),
    compactedUntilMessageId:
      typeof data.compactedUntilMessageId === "string"
        ? data.compactedUntilMessageId
        : null,
    ...(typeof data.compactedUntilIndex === "number"
      ? { compactedUntilIndex: data.compactedUntilIndex }
      : {}),
    facts: readFacts(data.facts),
    decisions: readItems(data.decisions),
    unresolved: readItems(data.unresolved),
    userConstraints: readItems(data.userConstraints),
  };
}
