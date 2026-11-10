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

import { renderMemoryText } from "../../context/buildContext.js";
import type { ContextMemoryBlock } from "../../context/types.js";

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
 */
export function buildWorkerMessages(
  systemPrompt: string,
  task: string,
  memoryBlock?: ContextMemoryBlock,
): WorkerMessage[] {
  const messages: WorkerMessage[] = [{ role: "system", content: systemPrompt }];

  if (memoryBlock && memoryBlock.items.length > 0) {
    const memoryText = renderMemoryText(memoryBlock);
    if (memoryText) {
      messages.push({ role: "system", content: memoryText });
    }
  }

  messages.push({ role: "user", content: task });
  return messages;
}
