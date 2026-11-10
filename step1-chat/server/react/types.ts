import type { ContextCompactionEvent } from "../context/types.js";
import type { MemoryTraceEvent } from "../memory/types.js";

/** ReAct 循环里发给模型的普通对话句（不含 tool 回填）。 */
export interface TextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 模型在 message.tool_calls 里给出的一项：调哪个函数、参数是什么。 */
export interface ProviderToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/** chat/completions 非流式返回里的一条 choice。 */
export interface ProviderChoice {
  finish_reason?: string;
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: ProviderToolCall[];
    /** DeepSeek 思考模式：下一轮必须把该字段原样带回 messages。 */
    reasoning_content?: string | null;
  };
}

/**
 * 发给模型的完整 messages 数组元素。
 * assistant+tool_calls 与 role:"tool" 必须成对出现，id 才能对上。
 */
export type ProviderMessage =
  | TextMessage
  | {
      role: "assistant";
      content: string | null;
      tool_calls: ProviderToolCall[];
      reasoning_content?: string | null;
    }
  | { role: "tool"; tool_call_id: string; content: string };

import type { JudgeResult } from "../guard/judgeSchema.js";

/**
 * Judge 影子判定事件。
 *
 * 同一条 trace 里同时带正则 Guard 结果与 Judge 结果，离线即可算分歧率。
 * 前端只展示，不参与任何判定。
 */
export type JudgeShadowTraceEvent = {
  type: "judge_shadow";
  mode: "shadow" | "enforce";
  /** 判定对象：用户输入 / 进入 prompt 的检索片段 / 模型输出。 */
  surface: "input" | "retrieval" | "output";
  guard: { level: string; rules: string[] };
  judge: JudgeResult;
  meta: {
    durationMs: number;
    truncated: boolean;
    originalChars: number;
    sentChars: number;
    attempts: number;
  };
};

/**
 * Judge enforce 决策事件。
 *
 * 与 judge_shadow 的区别：多了 action / label / disagree，
 * 表示这一轮「按决策表最终做了什么」——放行、拦截，还是只打标。
 * 前端只展示，不参与任何判定。
 */
export type JudgeEnforcedTraceEvent = {
  type: "judge_enforced";
  mode: "enforce";
  /** 判定对象：用户输入 / 进入 prompt 的检索片段 / 模型输出。 */
  surface: "input" | "retrieval" | "output";
  guard: { level: string; rules: string[] };
  judge: {
    status: string;
    risk?: string;
    confidence?: number;
    categories?: string[];
    shortReason?: string;
    errorKind?: string;
  };
  /** 最终动作：allow 放行 / block 拦截输入 / flag 建议按泄露处理。 */
  action: "allow" | "block" | "flag";
  /** 决策分支标签，便于统计各分支命中量。 */
  label?: string;
  /** 人可读的原因。 */
  reason?: string;
  /** Judge 结论与正则结论是否不一致。 */
  disagree: boolean;
  meta: {
    durationMs: number;
    truncated: boolean;
    originalChars: number;
    sentChars: number;
    attempts: number;
  };
};

/** 过程面板事件（SSE onTrace → 前端 ToolTrace）。
 *
 * 普通工具：tool_call → tool_result
 * 需确认工具：tool_call → pending_confirm →（用户操作）→ confirm_resolved → tool_result
 *
 * pending_confirm 携带 confirmId，供前端调 POST /api/chat/confirm。
 */
export type ToolTraceHandler = (
  event:
    | { type: "tool_call"; name: string; arguments: unknown }
    | { type: "tool_result"; name: string; result: unknown }
    | {
        type: "pending_confirm";
        confirmId: string;
        toolCallId: string;
        name: string;
        arguments: unknown;
      }
    | {
        type: "confirm_resolved";
        toolCallId: string;
        name: string;
        action: "allow" | "deny";
      }
    | { type: "searchDocs_empty"; level: "error" | "info"; message: string }
    | { type: "searchDocs_result"; result: unknown }
    | { type: "degradation"; reason: string; message: string }
    | { type: "injection_detected"; level?: string; rules: string[] }
    | { type: "output_leak_blocked"; matchedFingerprints: string[] }
    | JudgeShadowTraceEvent
    | JudgeEnforcedTraceEvent
    | ContextCompactionEvent
    | MemoryTraceEvent,
) => void;

/** ReAct 循环需要的最小选项，不绑死 chat.ts。 */
export interface ReactLoopOptions {
  messages: TextMessage[];
  model?: string;
  signal?: AbortSignal;
  baseUrl?: string;
  onDelta: (delta: string) => void;
  onTrace?: ToolTraceHandler;
  /**
   * 打开「搜索知识库」为 true（post-learning 语义 C）：
   * 服务端 prefetch 强制检索并注入本轮 system；ReAct **不**再把 searchDocs 发给模型。
   */
  searchDocs?: boolean;
  /** 每次 askModel 拿到 usage 时回调（Token 统计） */
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
  /**
   * 人工确认会话（阶段 B 由 /api/chat 创建并传入）。
   * - 传入：需确认工具会 pending + await，再 allow run / deny 回填
   * - 未传（当前默认）：需确认工具不执行，回填「未启用确认通道」
   */
  confirmSession?: import("./confirmGate.js").ConfirmSession;
}
