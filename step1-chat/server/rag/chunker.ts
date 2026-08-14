import type { ChunkOptions, DocumentChunk } from "./types.js";

/** 单块上限。宁可稍小，避免一段里混多个主题。 */
const DEFAULT_MAX_CHARS = 400;
/** overlap 占 maxChars 的比例，只为接缝，不是越大越好。 */
const DEFAULT_OVERLAP_RATIO = 0.15;

/** 按标题切开后的一节：标题 + 该标题下的正文。 */
interface Section {
  title: string;
  body: string;
}

/**
 * 把 Markdown 切成可检索的 chunk。
 *
 * 四步：
 * 1. 按 # / ## / ### 分成若干节（保结构）
 * 2. 节内按空行拆段落，尽量把相邻小段落拼到 maxChars 以内（保意思）
 * 3. 单段或攒满后仍超长 → 二次切，块与块之间留 overlap（保接缝）
 * 4. 每块带上 title、id、source、seq，供后面入库和引用
 */
export function chunkMarkdown(
  markdown: string,
  source: string,
  options: ChunkOptions = {},
): DocumentChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapRatio = options.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
  const overlapChars = Math.max(1, Math.floor(maxChars * overlapRatio));

  const sections = splitByHeadings(markdown);
  const rawPieces: Array<{ title: string; text: string }> = [];

  for (const section of sections) {
    const paragraphs = splitParagraphs(section.body);
    // 正在往里攒的当前块正文（尚未写成 chunk）
    let buffer = "";

    /** 把 buffer 落成一块或多块（超长会再切），然后清空 buffer。 */
    const flush = () => {
      const text = buffer.trim();
      buffer = "";
      if (!text || isJunk(text)) return;
      for (const piece of splitLongText(text, maxChars, overlapChars)) {
        rawPieces.push({
          title: section.title,
          text: withTitlePrefix(section.title, piece),
        });
      }
    };

    for (const paragraph of paragraphs) {
      if (!paragraph) continue;
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;

      // 拼上后仍不超过上限：继续攒，让一块尽量是完整意思
      if (candidate.length <= maxChars) {
        buffer = candidate;
        continue;
      }

      // 拼上会超：先把已攒的内容落盘
      if (buffer) flush();

      if (paragraph.length <= maxChars) {
        // 当前段本身不超，作为下一块的起点
        buffer = paragraph;
      } else {
        // 当前段单独就超长：直接二次切，不再进 buffer
        for (const piece of splitLongText(paragraph, maxChars, overlapChars)) {
          rawPieces.push({
            title: section.title,
            text: withTitlePrefix(section.title, piece),
          });
        }
        buffer = "";
      }
    }

    // 本节剩余未落盘的内容
    if (buffer) flush();
  }

  // 用文件名（去掉后缀）当 id 前缀，方便以后按文档追溯
  const stem = source.replace(/\.[^.]+$/, "") || "doc";
  return rawPieces.map((piece, seq) => ({
    id: `${stem}-chunk-${seq}`,
    source,
    title: piece.title,
    text: piece.text,
    seq,
  }));
}

/**
 * 按 Markdown 标题把全文拆成一节节 { title, body }。
 *
 * 只认行首的 # / ## / ###（对应 h1～h3）。更深的标题当普通正文。
 * 标题行本身不写入 body，只记在 title 里；后面入库、引用都靠这个 title。
 *
 * 扫描时始终维护「当前节」：
 * - title：当前节标题；文首在第一个标题之前时为空字符串
 * - bodyLines：当前节已经读到的正文行
 *
 * 碰到新标题 = 上一节结束：先 push 上一节，再把 title 换成新标题，body 从空开始。
 * 循环结束后还要再 push 一次，否则最后一节会丢。
 */
function splitByHeadings(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Section[] = [];
  let title = "";
  let bodyLines: string[] = [];

  /** 把当前 title + bodyLines 收成一节。两者都空（文首空白）则跳过。 */
  const push = () => {
    const body = bodyLines.join("\n").trim();
    if (!title && !body) return;
    sections.push({ title, body });
    bodyLines = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (heading) {
      push();
      title = heading[2].trim();
      continue;
    }
    bodyLines.push(line);
  }
  push();
  return sections;
}

/** 按空行拆段落。空行是 Markdown 里最自然的意思边界。 */
function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 超长文本的二次切：一段已经超过 maxChars 时才走这里。
 *
 * 用滑动窗口从左往右切：
 * 1. 先取 [start, start + maxChars) 作为候选窗口
 * 2. 在窗口里找最后一个换行 / 「。」 / 「；」，尽量在句子边界断开
 *    找不到合适断点（太靠前）就硬切在 maxChars，避免切出过碎的块
 * 3. 收下这一片后，下一块的 start 不是紧挨着 end，
 *    而是回退 overlapChars。这样交界处的句子会同时出现在两块里，
 *    检索时不会因为「关键句刚好在缝上」而两边都搜不到
 *
 * 不超长则原样返回，一层数组，调用方不用特判。
 */
function splitLongText(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // 还没到文末时，尝试把切断点挪到窗口内最后一个句子边界
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("；"));
      if (breakAt >= Math.floor(maxChars * 0.4)) {
        end = start + breakAt + 1;
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) parts.push(piece);
    if (end >= text.length) break;

    // 下一块从 end 往前回退 overlap，保证接缝处有重叠
    start = Math.max(0, end - overlapChars);
    if (start >= end) start = end;
  }
  return parts;
}

/** 标题带到块首，单独读这一块时能知道它属于哪一节。已带标题则不重复加。 */
function withTitlePrefix(title: string, body: string): string {
  const trimmed = body.trim();
  if (!title) return trimmed;
  if (trimmed.startsWith(title) || trimmed.startsWith(`# ${title}`) || trimmed.startsWith(`## ${title}`)) {
    return trimmed;
  }
  return `${title}\n\n${trimmed}`;
}

/** 丢掉没有独立信息的块，避免污染后面的检索。 */
function isJunk(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 8) return true;
  if (/^(目录|目\s*录)$/u.test(compact)) return true;
  if (/^第\s*\d+\s*页$/u.test(compact)) return true;
  return false;
}
