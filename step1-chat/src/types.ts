export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  /** 仅资料问答的助手气泡会带：是否判空、有没有调模型、Top1 分数 */
  rag?: RagMeta;
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
  | { kind: "output_leak_blocked"; matchedFingerprints: string[] };

/** 单次请求的 token 用量摘要（来自 SSE usage 事件） */
export interface UsageSnapshot {
  endpoint?: "chat" | "chat/multi" | "rag/chat";
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  estimatedCostUsd: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byEndpoint: Record<string, { requests: number; totalTokens: number; costUsd: number }>;
  byModel: Record<string, { requests: number; totalTokens: number; costUsd: number }>;
}

export interface ModelOption {
  id: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "gpt-5.4-mini", label: "GPT 5.4 mini" },
  { id: "gpt-5.6-sol", label: "GPT 5.6 sol" },
];
