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

export interface RagMeta {
  empty: boolean;
  calledModel: boolean;
  topScore: number | null;
  question: string;
  hits: RagHitView[];
}

export type ToolTraceStep =
  | { kind: "tool_call"; name: string; arguments: unknown }
  | { kind: "tool_result"; name: string; result: unknown };

export interface ModelOption {
  id: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { id: "gpt-5.4-mini", label: "GPT 5.4 mini" },
  { id: "gpt-5.6-sol", label: "GPT 5.6 sol" },
];
