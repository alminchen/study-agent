import type { TextMessage } from "./react/types.js";

/**
 * 只保留最近若干条用户/助手消息，并固定一条 system。
 * 避免把整段聊天史都塞给模型；system 始终由服务端注入，不用前端传来的。
 */
export function clipMessages(
  messages: TextMessage[],
  systemPrompt: string,
  maxContextMessages: number,
): TextMessage[] {
  const recent = messages.slice(-Math.max(1, maxContextMessages));
  return [{ role: "system", content: systemPrompt }, ...recent];
}
