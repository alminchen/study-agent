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
    | { type: "output_leak_blocked"; matchedFingerprints: string[] },
) => void;

/** ReAct 循环需要的最小选项，不绑死 chat.ts。 */
export interface ReactLoopOptions {
  messages: TextMessage[];
  model?: string;
  signal?: AbortSignal;
  baseUrl?: string;
  onDelta: (delta: string) => void;
  onTrace?: ToolTraceHandler;
  /** 打开「搜索知识库」为 true：prefetch 强制检索，且请求里带上 searchDocs 工具。 */
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
