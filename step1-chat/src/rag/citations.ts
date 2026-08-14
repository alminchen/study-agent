import type { RagHitView } from "../types";

export type ContentPart =
  | { kind: "text"; text: string }
  | { kind: "cite"; n: number; valid: boolean };

/**
 * 把回答拆成普通文字 + [n]。
 * valid 只认本次注入 prompt 的编号；模型瞎写的 [9] 标成无效，不能当依据。
 */
export function splitCitedText(content: string, validIndexes: Set<number>): ContentPart[] {
  const parts: ContentPart[] = [];
  const pattern = /\[(\d+)\]/g;
  let last = 0;
  let match = pattern.exec(content);
  while (match) {
    if (match.index > last) {
      parts.push({ kind: "text", text: content.slice(last, match.index) });
    }
    const n = Number(match[1]);
    parts.push({ kind: "cite", n, valid: validIndexes.has(n) });
    last = match.index + match[0].length;
    match = pattern.exec(content);
  }
  if (last < content.length) {
    parts.push({ kind: "text", text: content.slice(last) });
  }
  return parts;
}

/** 本次真正进了资料块的 [n]，来自命中列表的 promptIndex，不是模型正文。 */
export function validPromptIndexes(hits: RagHitView[] | undefined): Set<number> {
  const indexes = new Set<number>();
  for (const hit of hits ?? []) {
    if (hit.promptIndex != null) indexes.add(hit.promptIndex);
  }
  return indexes;
}

export function findHitByPromptIndex(
  hits: RagHitView[] | undefined,
  n: number,
): RagHitView | undefined {
  return (hits ?? []).find((hit) => hit.promptIndex === n);
}
