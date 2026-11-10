/**
 * 结构化输出的共享数据契约。
 *
 * 请求、最终结果、中间快照、错误码和 SSE 事件都集中在这里；服务端路由与前端
 * 类型需要保持同名同义，避免浏览器自行猜测模型文本形状。
 */
import { z } from "zod";

/** 首版结构化协议的版本号；字段语义变化时应升级。 */
export const STRUCTURED_SCHEMA_VERSION = 1 as const;

/** 限制模型输出和界面尺寸，避免单个结构化结果无限增长。 */
export const STRUCTURED_LIMITS = {
  titleMaxChars: 80,
  tableColumnsMax: 8,
  tableColumnNameMaxChars: 120,
  tableRowsMax: 50,
  tableCellMaxChars: 2_000,
  codeLanguageMaxChars: 32,
  codeContentMaxChars: 20_000,
  requestMessagesMax: 100,
  requestMessageContentMaxChars: 20_000,
  modelMaxChars: 120,
} as const;

const requiredText = (maxChars: number, label: string) =>
  z
    .string()
    .max(maxChars, `${label}不能超过 ${maxChars} 个字符`)
    .refine((value) => value.trim().length > 0, `${label}不能为空`);

/** 首版只开放两种可安全渲染且容易校验的 block。 */
export const StructuredTargetSchema = z.enum(["table", "code"]);
export type StructuredTarget = z.infer<typeof StructuredTargetSchema>;

/**
 * 结构化端点请求契约。
 *
 * 浏览器只能传对话消息、模型名和目标类型；system prompt、JSON mode 和超时均由
 * 服务端配置决定，避免客户端绕过协议约束。
 */
export const StructuredChatRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: requiredText(
              STRUCTURED_LIMITS.requestMessageContentMaxChars,
              "消息内容",
            ),
          })
          .strict(),
      )
      .min(1, "messages 至少需要一条消息")
      .max(STRUCTURED_LIMITS.requestMessagesMax, "messages 不能超过 100 条"),
    model: requiredText(STRUCTURED_LIMITS.modelMaxChars, "模型名"),
    target: StructuredTargetSchema,
    /**
     * 匿名用户 id（跨会话记忆的归属键）；非法 id 按「没开记忆」处理。
     *
     * 关掉记忆时前端**连 userId 一起不带**：
     * 服务端要求 allowMemory === true 且 userId 合法才检索，缺一不可。
     */
    userId: z.string().optional(),
    /** 是否启用长期记忆；false / 不传时零检索、零抽取。 */
    allowMemory: z.boolean().optional(),
  })
  .strict();

export type StructuredChatRequest = z.infer<typeof StructuredChatRequestSchema>;

/** 表格块：columns 定义列，rows 中每一行的宽度在最终 superRefine 中复核。 */
const TableBlockSchema = z
  .object({
    kind: z.literal("table"),
    title: requiredText(STRUCTURED_LIMITS.titleMaxChars, "标题"),
    columns: z
      .array(requiredText(STRUCTURED_LIMITS.tableColumnNameMaxChars, "列名"))
      .min(1, "表格至少需要一列")
      .max(STRUCTURED_LIMITS.tableColumnsMax, "表格不能超过 8 列"),
    rows: z
      .array(
        z
          .array(z.string().max(STRUCTURED_LIMITS.tableCellMaxChars, "单元格内容过长"))
          .min(1, "表格行不能为空")
          .max(STRUCTURED_LIMITS.tableColumnsMax, "表格行不能超过 8 个单元格"),
      )
      .max(STRUCTURED_LIMITS.tableRowsMax, "表格不能超过 50 行"),
  })
  .strict();

/** 代码块：language 仅用于展示，content 保持纯文本，不在服务端执行。 */
const CodeBlockSchema = z
  .object({
    kind: z.literal("code"),
    title: requiredText(STRUCTURED_LIMITS.titleMaxChars, "标题"),
    language: requiredText(STRUCTURED_LIMITS.codeLanguageMaxChars, "代码语言"),
    content: z
      .string()
      .max(
        STRUCTURED_LIMITS.codeContentMaxChars,
        `代码内容不能超过 ${STRUCTURED_LIMITS.codeContentMaxChars} 个字符`,
      ),
  })
  .strict();

/** 用 kind 做 discriminated union，避免 table/code 字段互相污染。 */
export const StructuredBlockSchema = z.discriminatedUnion("kind", [
  TableBlockSchema,
  CodeBlockSchema,
]);

export type StructuredBlock = z.infer<typeof StructuredBlockSchema>;

/** table 的 rows 在 block 层校验，因此每行宽度需要在这里对照 columns。 */
function addTableWidthIssues(block: StructuredBlock, ctx: z.RefinementCtx): void {
  if (block.kind !== "table") return;
  block.rows.forEach((row, rowIndex) => {
    if (row.length !== block.columns.length) {
      ctx.addIssue({
        code: "custom",
        path: ["block", "rows", rowIndex],
        message: `第 ${rowIndex + 1} 行有 ${row.length} 个单元格，但表格有 ${block.columns.length} 列`,
      });
    }
  });
}

/** 最终结果只能在模型结束后使用，必须通过完整 schema。 */
export const StructuredResultSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_SCHEMA_VERSION),
    block: StructuredBlockSchema,
  })
  .strict()
  .superRefine((result, ctx) => addTableWidthIssues(result.block, ctx));

export type StructuredResult = z.infer<typeof StructuredResultSchema>;

/**
 * 中间快照用于生成中的 UI，不写入最终历史。
 * 它比最终结果多了 revision，但字段仍必须满足同一套 block 约束。
 */
export const StructuredSnapshotSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_SCHEMA_VERSION),
    revision: z.number().int().nonnegative(),
    block: StructuredBlockSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => addTableWidthIssues(snapshot.block, ctx));

export type StructuredSnapshot = z.infer<typeof StructuredSnapshotSchema>;

export const STRUCTURED_ERROR_CODES = [
  "model_request_failed",
  "model_stream_interrupted",
  "partial_parse_failed",
  "invalid_final_json",
  "schema_validation_failed",
  "provider_json_mode_unsupported",
] as const;

/** 前端可稳定分支处理的错误码；message 只用于诊断，不参与业务判断。 */
export const StructuredErrorCodeSchema = z.enum(STRUCTURED_ERROR_CODES);
export type StructuredErrorCode = z.infer<typeof StructuredErrorCodeSchema>;

/**
 * 新结构化端点的 SSE 协议。
 *
 * snapshot 是前端唯一的增量渲染源；delta 只报告接收进度，不携带模型原始 JSON。
 */
export interface StructuredStartEvent {
  /** 每次请求唯一，便于把 SSE、usage 和 trace 串起来。 */
  type: "structured_start";
  requestId: string;
  schemaVersion: typeof STRUCTURED_SCHEMA_VERSION;
}

export interface StructuredDeltaEvent {
  /** 只报告已接收进度，不携带模型原始 JSON。 */
  type: "structured_delta";
  sequence: number;
  receivedChars: number;
}

export interface StructuredSnapshotEvent {
  /** revision 单调递增，前端只接受更大的值。 */
  type: "structured_snapshot";
  revision: number;
  snapshot: StructuredSnapshot;
}

export interface StructuredDoneEvent {
  /** result 必须已经通过 StructuredResultSchema。 */
  type: "structured_done";
  revision: number;
  result: StructuredResult;
}

export interface StructuredErrorEvent {
  /** lastRevision 允许前端保留最后一个可安全展示的快照。 */
  type: "structured_error";
  code: StructuredErrorCode;
  message: string;
  retryable: boolean;
  lastRevision: number;
}

export interface StructuredUsageEvent {
  /** usage 沿用全项目统一字段，endpoint 固定为 chat/structured。 */
  type: "usage";
  endpoint: "chat/structured";
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls: number;
  estimatedCostUsd: number;
}

export type StructuredSseEvent =
  | StructuredStartEvent
  | StructuredDeltaEvent
  | StructuredSnapshotEvent
  | StructuredDoneEvent
  | StructuredErrorEvent
  | StructuredUsageEvent;
