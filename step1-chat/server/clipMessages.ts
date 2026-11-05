import type { TextMessage } from "./react/types.js";

/**
 * 只保留最近若干条用户/助手消息，并固定一条 system。
 * 避免把整段聊天史都塞给模型；system 始终由服务端注入，不用前端传来的。
 *
 * **这是旧版（按条数截断）的实现，行为保持不变。**
 * 新链路（按 token 预算分层保留 + 结构化摘要）用的是 `server/context/buildContext.ts`，
 * 两者互不替代：旧函数继续服务 /api/chat/plan 的 ReAct 回退分支与基线脚本，
 * 以保证那些链路的行为不因为本阶段改造而变化。
 */
export function clipMessages(
  messages: TextMessage[],
  systemPrompt: string,
  maxContextMessages: number,
): TextMessage[] {
  const recent = messages.slice(-Math.max(1, maxContextMessages));
  return [{ role: "system", content: systemPrompt }, ...recent];
}
