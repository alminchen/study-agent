import { retrieveForAnswer } from "../../rag/retrieve.js";
import type { SearchHit } from "../../rag/types.js";

/** 模型调用 searchDocs 时必须带上的参数 */
export interface SearchDocsArgs {
  question: string;
}

/** 回填模型用：有资料时的一段原文。不含 embedding。 */
export interface SearchDocsHitView {
  id: string;
  source: string;
  title: string;
  text: string;
  score: number;
}

export interface SearchDocsResult {
  empty: false;
  hits: SearchDocsHitView[];
}

export interface ExecuteSearchDocsOptions {
  /** 聊天 prefetch 可传更小候选数 */
  candidateK?: number;
  signal?: AbortSignal;
}

function toHitView(hit: SearchHit): SearchDocsHitView {
  return {
    id: hit.chunk.id,
    source: hit.chunk.source,
    title: hit.chunk.title,
    text: hit.chunk.text,
    score: hit.score,
  };
}

/** 把模型给的 arguments 解析成问句；不合法就返回 error，不抛错。 */
export function parseSearchDocsArgs(
  raw: string,
): { ok: true; args: SearchDocsArgs } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "searchDocs 参数不是合法 JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'searchDocs 参数必须是对象，例如 {"question":"文档怎么切分"}' };
  }

  const question = (parsed as { question?: unknown }).question;
  if (typeof question !== "string" || question.trim() === "") {
    return { ok: false, error: "缺少参数 question，需要提供要检索的问题" };
  }

  return { ok: true, args: { question: question.trim() } };
}

/**
 * 复用阶段 3 的 retrieveForAnswer：分数门槛和标题例外仍在 rag/，这里只负责变成工具结果。
 *
 * **P1 改动**：区分三类失败话术——
 * 1. 向量库空 / 系统异常 → 明确告知是系统问题
 * 2. 有召回但判空（分数低）→ 标准「资料里没有相关内容」
 * 3. 正常返回
 */
export async function executeSearchDocs(
  args: SearchDocsArgs,
  options?: ExecuteSearchDocsOptions,
): Promise<SearchDocsResult | { error: string }> {
  try {
    const judgment = await retrieveForAnswer(args.question, undefined, undefined, {
      signal: options?.signal,
      candidateK: options?.candidateK,
    });
    if (judgment.empty) {
      return { error: judgment.message ?? "资料里没有相关内容" };
    }
    return {
      empty: false,
      hits: judgment.hits.map(toHitView),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "检索失败";
    if (msg.includes("向量库是空的")) {
      return { error: "知识库尚未初始化，请先运行入库命令（npm run rag:ingest）" };
    }
    return { error: `检索服务异常：${msg}` };
  }
}

/** 给 findTool 用：解析失败或检索失败都返回 `{ error }`，不往外 throw。 */
export async function runSearchDocs(rawArguments: string): Promise<unknown> {
  const parsed = parseSearchDocsArgs(rawArguments);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return executeSearchDocs(parsed.args);
}
