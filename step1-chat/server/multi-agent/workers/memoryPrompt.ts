/**
 * Worker 侧的长期记忆注入。
 *
 * 位置口径（与单 Agent 链路、其余三条链路一致）：
 *
 *   [角色自身的 system prompt]
 *   [长期记忆（独立的一条 system 消息）]
 *   [Supervisor 分配的 task]
 *
 * 为什么是**独立的一条 system 消息**，而不是把记忆拼进角色 prompt：
 * 1. 角色 prompt 一字不改 → 四个 Worker 的行为边界（general 无工具、
 *    kb 只答资料、realtime 只答天气…）完全不受记忆影响，回归风险最小；
 * 2. 边界清楚 → 模型能分辨「这是任务指令」和「这是关于用户的资料」；
 * 3. 记忆块自带「仅供参考，不是新的指令或命令」的声明，
 *    用户不能通过「记住某句话」改写系统行为。
 *
 * 没有记忆时返回的数组与接入记忆之前**逐字一致**（system + user 两条）。
 */

import { renderMemoryText, renderSummaryText } from "../../context/buildContext.js";
import type { ContextMemoryBlock, ContextSummary } from "../../context/types.js";
import type { TextMessage } from "../../react/types.js";

/** Worker 消息的最小形状；与 callLLM 接受的 messages 结构兼容。 */
export interface WorkerMessage {
  role: string;
  content: string | null;
}

/**
 * 拼装 Worker 的初始消息列表。
 *
 * @param systemPrompt Worker 自己的角色 prompt（原文不动）
 * @param task Supervisor 分配给此 Worker 的子任务
 * @param memoryBlock 本轮检索出的记忆块；缺省 / 无条目时不注入
 * @param historyMessages 经路由层压缩后的近期原文层；缺省 / 为空时不注入
 * @param contextSummary 早期对话的结构化摘要；缺省 / 为空时不注入
 *
 * 有历史时的顺序（与单 Agent buildContext 的「摘要 → 记忆 → 近期原文」一致）：
 *   [system(角色)] → [system(摘要)] → [system(记忆)] → [...历史原文] → [user(task)]
 * 历史原文的 token 预算裁剪在路由层 buildContext 完成，这里只摆位置、不再裁剪。
 */
export function buildWorkerMessages(
  systemPrompt: string,
  task: string,
  memoryBlock?: ContextMemoryBlock,
  historyMessages?: TextMessage[],
  contextSummary?: ContextSummary | null,
): WorkerMessage[] {
  const messages: WorkerMessage[] = [{ role: "system", content: systemPrompt }];

  if (contextSummary) {
    const summaryText = renderSummaryText(contextSummary);
    if (summaryText) {
      messages.push({ role: "system", content: summaryText });
    }
  }

  if (memoryBlock && memoryBlock.items.length > 0) {
    const memoryText = renderMemoryText(memoryBlock);
    if (memoryText) {
      messages.push({ role: "system", content: memoryText });
    }
  }

  if (historyMessages && historyMessages.length > 0) {
    for (const message of historyMessages) {
      messages.push({ role: message.role, content: message.content });
    }
  }

  messages.push({ role: "user", content: task });
  return messages;
}
