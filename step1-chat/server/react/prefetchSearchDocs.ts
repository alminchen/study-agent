import { executeSearchDocs } from "../tools/methods/searchDocs.js";
import type { SearchDocsHitView, SearchDocsResult } from "../tools/methods/searchDocs.js";
import { isRerankDegraded } from "../rag/rerank.js";
import type { ConsecutiveFailureTracker } from "./toolFailure.js";
import type { ProviderMessage, ReactLoopOptions } from "./types.js";

/** 从 messages 取最后一条 user 文本。 */
export function getLastUserText(messages: ProviderMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i];
    if (row?.role === "user" && "content" in row) {
      return row.content.trim();
    }
  }
  return "";
}

function formatHitsForModel(hits: SearchDocsHitView[]): string {
  return hits
    .map((hit, index) => {
      const n = index + 1;
      const heading = hit.title ? ` title="${hit.title}"` : "";
      return `[${n}] id=${hit.id} source=${hit.source}${heading}\n${hit.text}`;
    })
    .join("\n\n");
}

function formatSearchDocsContext(result: SearchDocsResult): string {
  return `【本轮知识库检索结果】只对当前这一轮有效。\n${formatHitsForModel(result.hits)}`;
}

/** 检索结果写进本轮 system，不进对话历史，避免下一轮取消勾选后模型还当自己说过这些资料。 */
function appendToSystem(messages: ProviderMessage[], extra: string) {
  const first = messages[0];
  if (first?.role === "system" && "content" in first) {
    first.content = `${first.content}\n\n${extra}`;
  }
}

export interface PrefetchResult {
  ran: boolean;
  /** 检索判空：无可用资料，不应再调 LLM（对齐 /api/rag/chat 的做法）。 */
  empty: boolean;
  /** 判空时的固定文案，调用方直接 onDelta 并结束。 */
  emptyMessage: string | null;
  /** true = 系统故障（库空/异常），false = 正常判空（分数低）。前端可据此展示不同样式。 */
  isSystemError?: boolean;
}

/**
 * 勾选「搜索知识库」时：在第一次 askModel 之前强制检索（保证必走资料库）。
 * searchDocs 仍挂进模型 tools。
 *
 * **P0 改动**：判空后返回 `empty: true`，由 `runConversation` 直接用固定文案回复，
 * 不再注入 system 让模型继续——避免模型编造文档名和章节号。
 *
 * 有资料时，结果仍追加到本轮 system，不伪造 assistant / tool_calls。
 */
export async function prefetchSearchDocsIfEnabled(
  messages: ProviderMessage[],
  options: ReactLoopOptions,
  failures: ConsecutiveFailureTracker,
): Promise<PrefetchResult> {
  if (!options.searchDocs) return { ran: false, empty: false, emptyMessage: null };

  const question = getLastUserText(messages);
  if (!question) return { ran: false, empty: false, emptyMessage: null };

  const args = { question };
  options.onTrace?.({
    type: "tool_call",
    name: "searchDocs",
    arguments: args,
  });

  console.log("\n=== 0) 强制检索知识库（已勾选开关）===");
  const result = await executeSearchDocs(args);
  failures.record("searchDocs", result);

  console.log(JSON.stringify(result, null, 2));
  options.onTrace?.({
    type: "tool_result",
    name: "searchDocs",
    result,
  });

  if ("error" in result) {
    const isSystemError = result.error.startsWith("检索服务异常") || result.error.includes("尚未初始化");
    return { ran: true, empty: true, emptyMessage: result.error, isSystemError };
  }

  if (isRerankDegraded()) {
    options.onTrace?.({
      type: "degradation",
      reason: "rerank_unavailable",
      message: "重排模型未加载，检索结果仅用向量相似度排序，质量可能下降",
    });
  }

  appendToSystem(messages, formatSearchDocsContext(result));
  return { ran: true, empty: false, emptyMessage: null };
}
