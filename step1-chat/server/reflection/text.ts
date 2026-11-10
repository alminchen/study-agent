/**
 * Reflection 模块共用的小工具。
 *
 * 单独成文件是为了让 Critic 与 Revise 共用同一套截断/去围栏口径，
 * 避免两个模块各写一份行为略有差异的实现。
 */

/** 保留首尾片段，中间用截断标记替代；超长输入不会被静默砍掉尾巴。 */
export function truncateMiddle(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  const marker = `\n…[中间 ${text.length} 字符已截断]…\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const headLength = Math.floor(budget * 0.6);
  const tailLength = budget - headLength;
  return {
    text:
      text.slice(0, headLength) +
      marker +
      (tailLength > 0 ? text.slice(text.length - tailLength) : ""),
    truncated: true,
  };
}

/**
 * 去掉包住整段内容的代码块标记。
 *
 * 只处理"整段被一个围栏包住"的情况；正文里出现的行内代码不动。
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
