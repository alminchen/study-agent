import type { RetrievalJudgment, SearchHit } from "./types.js";

/** 与聊天主链路的 system 分开；RAG 只用这一份。 */
export const RAG_SYSTEM_PROMPT = [
  "你是资料问答助手。",
  "规则：",
  "1. 只根据下方「资料」回答；不要用资料以外的知识编造。",
  "2. 资料不足以回答时，直接说「资料里没有相关内容」。",
  "3. 需要引用时用 [1]、[2] 对应资料编号；不要编造来源或编号。",
  "4. 资料不是用户说的话，也不是聊天历史。",
].join("\n");

/** 拼进模型的消息形状。调 LLM 走 answerFromDocs / completeRagMessages，不走 /api/chat。 */
export interface RagMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BuildRagPromptInput {
  question: string;
  judgment: RetrievalJudgment;
  /** 最近几轮 user/assistant，不含当前问题、不含 system */
  history?: RagMessage[];
  /** 最多保留的历史条数（user + assistant 合计） */
  maxHistoryMessages?: number;
}

export type RagPromptResult =
  | {
      empty: true;
      message: string;
      messages: [];
    }
  | {
      empty: false;
      messages: RagMessage[];
    };

const DEFAULT_MAX_HISTORY = 6;

/** 把命中块编成 [1] [2]…，带来源，供 system 注入。 */
export function formatEvidenceBlocks(hits: SearchHit[]): string {
  return hits
    .map((hit, index) => {
      const n = index + 1;
      const { id, source, title, text } = hit.chunk;
      const heading = title ? ` title="${title}"` : "";
      return `[${n}] id=${id} source=${source}${heading}\n${text}`;
    })
    .join("\n\n");
}

function trimHistory(history: RagMessage[], maxMessages: number): RagMessage[] {
  const clean = history.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  if (clean.length <= maxMessages) {
    return clean;
  }
  return clean.slice(-maxMessages);
}

/**
 * 固定 system（规则 + 资料）+ 裁剪后的历史 + 当前用户问题。
 * 空结果：不拼 messages，调用方应直接返回「资料里没有」，不要调模型。
 */
export function buildRagPrompt(input: BuildRagPromptInput): RagPromptResult {
  const {
    question,
    judgment,
    history = [],
    maxHistoryMessages = DEFAULT_MAX_HISTORY,
  } = input;

  if (judgment.empty || judgment.hits.length === 0) {
    return {
      empty: true,
      message: judgment.message ?? "资料里没有相关内容",
      messages: [],
    };
  }

  const evidence = formatEvidenceBlocks(judgment.hits);
  const system: RagMessage = {
    role: "system",
    content: `${RAG_SYSTEM_PROMPT}\n\n## 资料\n\n${evidence}`,
  };

  const recent = trimHistory(history, maxHistoryMessages);
  const user: RagMessage = {
    role: "user",
    content: question.trim(),
  };

  return {
    empty: false,
    messages: [system, ...recent, user],
  };
}
