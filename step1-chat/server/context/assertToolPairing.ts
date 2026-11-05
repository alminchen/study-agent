/**
 * 工具消息配对断言。
 *
 * 背景：发给模型的 messages 里，`assistant.tool_calls[i].id` 必须与后面
 * `role:"tool"` 的 `tool_call_id` 一一对应。配对断了会出现三种症状：
 *
   1. **孤儿 tool_calls**——模型要求调工具，但没有回填结果。
      供应商侧通常直接 400（"messages 中 tool_calls 没有对应 tool 消息"）。
   2. **孤儿 tool 结果**——有 tool 消息但没有对应的 assistant 请求。
      同样 400，或者模型把上一轮的旧结果当成本轮输入。
   3. **顺序颠倒**——tool 结果出现在它对应的 assistant **之前**。
      语义错乱：模型会看到"结果先于问题"。
 *
 * 这三种都属于"拼消息时拼错了"，而且往往在很靠后的一轮才暴露，
 * 排查成本高。所以在拼装的地方就地断言，把错误挡在发出去之前。
 *
 * 断言只做**结构**检查，不看内容、不调模型，纯函数、无副作用。
 */
import type { ProviderMessage } from "../react/types.js";

/** 判断一条消息是不是「带 tool_calls 的 assistant」。 */
function isAssistantWithToolCalls(
  message: ProviderMessage,
): message is Extract<ProviderMessage, { tool_calls: unknown }> {
  return "tool_calls" in message && Array.isArray(message.tool_calls);
}

/**
 * 校验一批消息里 tool_calls 与 tool 结果是否严格配对。
 *
 * 校验四件事：
 * - 每个 tool_call.id 只出现一次（重复声明 = 后面必然有一个结果对不上）；
 * - 每个 tool 结果都能找到声明它的 assistant；
 * - tool 结果出现在声明它的 assistant **之后**；
 * - 每个 tool_call 都恰好被回填一次（既不孤儿，也不重复回填）。
 *
 * 任何一条不满足就抛错，错误信息里带上具体的 tool_call_id，
 * 方便直接定位到是哪一轮的工具调用出了问题。
 */
export function assertToolPairing(messages: ProviderMessage[]): void {
  /** tool_call_id → 声明它的 assistant 在数组里的下标。 */
  const declaredAt = new Map<string, number>();
  /** tool_call_id → 被回填的位置。 */
  const answeredAt = new Map<string, number>();

  messages.forEach((message, index) => {
    if (!isAssistantWithToolCalls(message)) return;
    for (const call of message.tool_calls) {
      if (declaredAt.has(call.id)) {
        throw new Error(
          `[assertToolPairing] tool_call id 重复声明：${call.id}`,
        );
      }
      declaredAt.set(call.id, index);
    }
  });

  messages.forEach((message, index) => {
    if (message.role !== "tool") return;
    const toolCallId = message.tool_call_id;
    const declaredIndex = declaredAt.get(toolCallId);

    // 失败路径：孤儿 tool 结果——没有 assistant 声明过这个 id。
    if (declaredIndex === undefined) {
      throw new Error(
        `[assertToolPairing] tool 结果没有对应的 assistant tool_calls：${toolCallId}`,
      );
    }
    // 失败路径：顺序颠倒——结果跑到了请求前面。
    if (index < declaredIndex) {
      throw new Error(
        `[assertToolPairing] tool 结果出现在对应 assistant 之前：${toolCallId}`,
      );
    }
    // 失败路径：同一个结果被回填了两次。
    if (answeredAt.has(toolCallId)) {
      throw new Error(
        `[assertToolPairing] tool 结果重复回填：${toolCallId}`,
      );
    }
    answeredAt.set(toolCallId, index);
  });

  for (const [toolCallId, index] of declaredAt) {
    // 失败路径：孤儿 tool_calls——声明了却没人回填。
    if (!answeredAt.has(toolCallId)) {
      throw new Error(
        `[assertToolPairing] assistant 的 tool_calls 缺少对应的 tool 结果：${toolCallId}（第 ${index} 条消息）`,
      );
    }
  }
}
