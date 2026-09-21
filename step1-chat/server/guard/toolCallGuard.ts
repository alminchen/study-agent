/**
 * 工具调用层防护：在执行工具之前校验模型返回的 tool_calls。
 *
 * 检查项：
 * 1. 工具名白名单——模型幻觉出不存在的工具名时直接拒绝
 * 2. 参数长度上限——防止注入超长 payload
 * 3. 参数基础类型校验——确保 JSON 可解析
 *
 * 设计原则：快速、无副作用、返回拒绝原因供 applyToolCalls 回填给模型。
 */

const ALLOWED_TOOLS = new Set(["getWeather", "getCurrentTime", "searchDocs", "draft_message"]);


const MAX_ARGUMENTS_LENGTH = 2048;

export interface ToolCallGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 校验单个 tool_call 是否允许执行。
 * @param name 模型返回的函数名
 * @param rawArguments 模型返回的 arguments 字符串
 */
export function validateToolCall(name: string, rawArguments: string): ToolCallGuardResult {
  if (!ALLOWED_TOOLS.has(name)) {
    return { allowed: false, reason: `工具「${name}」不在白名单中，拒绝执行` };
  }

  if (rawArguments.length > MAX_ARGUMENTS_LENGTH) {
    return {
      allowed: false,
      reason: `工具参数超长（${rawArguments.length} 字符，上限 ${MAX_ARGUMENTS_LENGTH}），疑似注入`,
    };
  }

  try {
    JSON.parse(rawArguments);
  } catch {
    return { allowed: false, reason: "工具参数不是合法 JSON" };
  }

  return { allowed: true };
}
