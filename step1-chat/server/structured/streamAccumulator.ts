import {
  parseStructuredChunk,
  type PartialParseState,
} from "./parsePartialJson.js";
import {
  StructuredResultSchema,
  type StructuredResult,
  type StructuredSnapshot,
} from "./types.js";

/**
 * 单个模型响应的累积器状态机。
 *
 * streaming 是唯一可继续接收 chunk 的状态；completed、failed、aborted 都是终态。
 * 路由层只根据这里的结果写 SSE，不直接解析模型文本。
 */
export type StructuredStreamStatus =
  | "streaming"
  | "completed"
  | "failed"
  | "aborted";

/** 用于日志和可观察性；不包含会持久化的模型原始文本。 */
export interface StructuredStreamStats {
  /** 当前状态机状态；只有 streaming 允许继续 append。 */
  status: StructuredStreamStatus;
  firstChunkAt: number | null;
  lastChunkAt: number | null;
  chunkCount: number;
  receivedChars: number;
  snapshotCount: number;
  rejectedChunkCount: number;
  lastRejectedChunkDiagnostic: string | null;
  revision: number;
  finishReason: string | null;
  parseTimeMs: number;
}

export interface AppendChunkResult {
  /** false 表示 chunk 到达终态之后，已被拒绝。 */
  accepted: boolean;
  /** 本次 append 产生的稳定快照；没有增长时为 null。 */
  snapshot: StructuredSnapshot | null;
  /** parser 的非致命诊断，用于日志，不直接作为 HTTP 错误。 */
  diagnostic: string | null;
}

export interface AbortStreamResult {
  /** 是否由本次调用完成 abort；重复 abort 返回 false 但仍保留最后快照。 */
  ok: boolean;
  revision: number;
  lastSnapshot: StructuredSnapshot | null;
  diagnostic: string | null;
}

/** 只记录定位 schema 错误所需的信息，不包含模型完整原文。 */
export interface StructuredValidationIssue {
  path: Array<string | number>;
  code: string;
  expected: string | null;
  actualType: string;
  message: string;
}

/** 结束流时本地状态机产生的诊断，不等同于对前端暴露的 StructuredErrorCode。 */
export type FinishErrorCode =
  | "invalid_final_json"
  | "schema_validation_failed"
  | "stream_already_finished"
  | "stream_already_aborted";

interface FinishStreamFailure {
  ok: false;
  code: FinishErrorCode;
  message: string;
  retryable: boolean;
  revision: number;
  lastSnapshot: StructuredSnapshot | null;
  repairAttempted: boolean;
  issues: StructuredValidationIssue[];
}

export type FinishStreamResult =
  | {
      ok: true;
      result: StructuredResult;
      revision: number;
      lastSnapshot: StructuredSnapshot | null;
      repairApplied: "stripped_json_fence" | null;
      finalTextLength: number;
    }
  | FinishStreamFailure;

/** 允许测试注入时钟；生产环境默认使用 Date.now。 */
export interface StructuredStreamAccumulatorOptions {
  now?: () => number;
}

const EMPTY_PARSE_STATE: PartialParseState = {
  revision: 0,
  lastRawLength: 0,
  lastSnapshot: null,
};

/**
 * 只接受整段文本被一层 JSON Markdown fence 包裹的情况。
 * 不递归剥离多层 fence，避免过度修复模型输出。
 */
function stripSingleJsonFence(text: string): string | null {
  const match = text
    .trim()
    .match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  const inner = match?.[1]?.trim();
  return inner ? inner : null;
}

/** 生成 schema issue 中可读的实际类型名。 */
function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value === undefined) return "undefined";
  return typeof value;
}

/** 按 Zod issue path 回查输入值，仅用于诊断，不改变校验结果。 */
function valueAtPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 截断并脱敏最终 schema issue，避免日志被超大模型原文撑爆。 */
function summarizeIssues(
  value: unknown,
  issues: ReadonlyArray<Record<string, unknown>>,
): StructuredValidationIssue[] {
  return issues.slice(0, 20).map((issue) => {
    const rawPath = Array.isArray(issue.path) ? issue.path : [];
    const path = rawPath.map((part) =>
      typeof part === "number" ? part : String(part),
    );
    const expected =
      typeof issue.expected === "string"
        ? issue.expected
        : issue.code === "invalid_union"
          ? "union"
          : null;
    const rawMessage =
      typeof issue.message === "string" ? issue.message : "schema 校验失败";

    return {
      path,
      code: typeof issue.code === "string" ? issue.code : "unknown",
      expected,
      actualType: actualType(
        "input" in issue && issue.input !== undefined
          ? issue.input
          : valueAtPath(value, path),
      ),
      message: rawMessage.replace(/\s+/g, " ").slice(0, 240),
    };
  });
}

export class StructuredStreamAccumulator {
  // 原始文本只存在服务端内存；对外只暴露快照、统计和校验结果。
  private readonly now: () => number;
  private accumulatedText = "";
  private parseState: PartialParseState = structuredClone(EMPTY_PARSE_STATE);
  private status: StructuredStreamStatus = "streaming";
  private firstChunkAt: number | null = null;
  private lastChunkAt: number | null = null;
  private chunkCount = 0;
  private receivedChars = 0;
  private snapshotCount = 0;
  private rejectedChunkCount = 0;
  private lastRejectedChunkDiagnostic: string | null = null;
  private finishReason: string | null = null;
  private parseTimeMs = 0;

  constructor(options: StructuredStreamAccumulatorOptions = {}) {
    // 注入时钟便于测试首 chunk 时间与解析耗时，不模拟解析器内部行为。
    this.now = options.now ?? Date.now;
  }

  /** 接收一个模型文本片段；只有 streaming 状态会累积和解析。 */
  append(chunk: string): AppendChunkResult {
    // 终态不可逆：只有 streaming 状态能继续接收模型输出。
    if (this.status !== "streaming") {
      const diagnostic =
        this.status === "aborted" ? "chunk_after_abort" : "chunk_after_finish";
      this.rejectedChunkCount += 1;
      this.lastRejectedChunkDiagnostic = diagnostic;
      return {
        accepted: false,
        snapshot: null,
        diagnostic,
      };
    }

    const chunkReceivedAt = this.now();
    if (this.firstChunkAt === null) this.firstChunkAt = chunkReceivedAt;
    this.lastChunkAt = chunkReceivedAt;
    this.chunkCount += 1;
    this.receivedChars += chunk.length;
    this.accumulatedText += chunk;

    // 每次 append 都对累计文本重新解析；parser 自身保持纯函数。
    const parseStartedAt = this.now();
    const parsed = parseStructuredChunk(this.accumulatedText, this.parseState);
    this.parseTimeMs += this.now() - parseStartedAt;
    this.parseState = parsed.state;
    if (parsed.nextSnapshot) this.snapshotCount += 1;

    return {
      accepted: true,
      snapshot: parsed.nextSnapshot,
      diagnostic: parsed.diagnostic,
    };
  }

  /** 记录供应商 finish_reason；不参与 JSON 解析。 */
  recordFinishReason(finishReason: string | null): void {
    this.finishReason = finishReason;
  }

  /** 中止未完成的流，并返回最后一份可安全展示的快照。 */
  abort(): AbortStreamResult {
    const diagnostic =
      this.status === "aborted"
        ? "stream_already_aborted"
        : this.status === "streaming"
          ? null
          : "stream_already_finished";

    // abort 是幂等终态操作：第一次进入 aborted，后续只返回诊断。
    if (this.status === "streaming") {
      this.status = "aborted";
    }

    return {
      ok: diagnostic === null,
      revision: this.parseState.revision,
      lastSnapshot: structuredClone(this.parseState.lastSnapshot),
      diagnostic,
    };
  }

  /** 对累计的完整文本做最终 JSON 和 schema 校验。 */
  finish(): FinishStreamResult {
    if (this.status !== "streaming") {
      const alreadyAborted = this.status === "aborted";
      return {
        ...this.finishFailure(
          alreadyAborted ? "stream_already_aborted" : "stream_already_finished",
          alreadyAborted
            ? "模型流已经中止，不能再次完成"
            : "模型流已经完成或失败，不能重复结束",
        ),
        retryable: false,
      };
    }

    const validationStartedAt = this.now();
    let value: unknown;
    let repairApplied: "stripped_json_fence" | null = null;
    let repairAttempted = false;
    // 最终校验只允许一次单层 JSON fence 修复，不递归猜测或补全内容。
    try {
      value = JSON.parse(this.accumulatedText);
    } catch {
      const stripped = stripSingleJsonFence(this.accumulatedText);
      repairAttempted = stripped !== null;
      if (stripped) {
        try {
          value = JSON.parse(stripped);
          repairApplied = "stripped_json_fence";
        } catch {
          // 只尝试一次本地 fence 修复，不递归猜测模型输出。
        }
      }
      if (repairApplied === null) {
        this.parseTimeMs += this.now() - validationStartedAt;
        this.status = "failed";
        return this.finishFailure(
          "invalid_final_json",
          "模型最终输出不是合法 JSON",
          repairAttempted,
        );
      }
    }

    // 本地修复完成后仍必须通过完整 Zod schema，快照通过不代表最终结果通过。
    const parsed = StructuredResultSchema.safeParse(value);
    this.parseTimeMs += this.now() - validationStartedAt;
    if (!parsed.success) {
      this.status = "failed";
      return this.finishFailure(
        "schema_validation_failed",
        "模型最终输出不符合结构化 schema",
        repairApplied !== null,
        summarizeIssues(
          value,
          parsed.error.issues.map(
            (issue) => issue as unknown as Record<string, unknown>,
          ),
        ),
      );
    }

    this.status = "completed";
    return {
      ok: true,
      result: parsed.data,
      revision: this.parseState.revision,
      lastSnapshot: structuredClone(this.parseState.lastSnapshot),
      repairApplied,
      finalTextLength: this.accumulatedText.length,
    };
  }

  /** 统一构造终态失败结果，保证 revision、最后快照和 issue 字段齐全。 */
  private finishFailure(
    code: FinishErrorCode,
    message: string,
    repairAttempted = false,
    issues: StructuredValidationIssue[] = [],
  ): FinishStreamFailure {
    return {
      ok: false,
      code,
      message,
      retryable: true,
      revision: this.parseState.revision,
      lastSnapshot: structuredClone(this.parseState.lastSnapshot),
      repairAttempted,
      issues,
    };
  }

  /** 返回快照副本之外的非敏感诊断统计。 */
  getStats(): StructuredStreamStats {
    return {
      status: this.status,
      firstChunkAt: this.firstChunkAt,
      lastChunkAt: this.lastChunkAt,
      chunkCount: this.chunkCount,
      receivedChars: this.receivedChars,
      snapshotCount: this.snapshotCount,
      rejectedChunkCount: this.rejectedChunkCount,
      lastRejectedChunkDiagnostic: this.lastRejectedChunkDiagnostic,
      revision: this.parseState.revision,
      finishReason: this.finishReason,
      parseTimeMs: this.parseTimeMs,
    };
  }
}
