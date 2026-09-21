/**
 * 知识库回答风格收敛器。
 *
 * 适用两条链路：
 * 1. /api/chat 勾选「搜索知识库」后的本轮回答
 * 2. /api/rag/chat 资料问答回答
 *
 * 目标：
 * - 保留正文回答与 [1][2] 这类行内引用
 * - 去掉检索内部元信息（id= / source= / title=）
 * - 去掉尾部单独列出的“来源:”区块
 * - 收敛多余空行，减少“像复制原文”的观感
 */

/** 形如“[1] id=... source=... title=...”的检索元信息行 */
const SOURCE_META_LINE_RE = /^\[\d+\]\s+id=.*source=.*$/m;

/** 尾部“来源:”区块：来源: / 来源： 后面跟若干条 [n] 文件名... */
const SOURCES_BLOCK_RE = /\n{0,2}来源[:：]\s*\n(?:\[\d+\].*\n?)+$/u;

/** 单独一行的 source=/id=/title= 型内部字段，直接删除 */
const INTERNAL_META_LINE_RE = /^.*(?:\bid=|\bsource=|\btitle=).*(?:\n|$)/gm;

/** 连续 3 个以上空行压成 2 个 */
const EXCESS_BLANKS_RE = /\n{3,}/g;

/**
 * 把知识库回答裁成更像“答案”，而不是“检索结果打印”。
 *
 * 说明：
 * - 不改正文里的 [1][2] 行内引用
 * - 不试图强行重写句子，只做保守删除/清理
 * - 若用户将来明确要求“显示完整来源清单”，应跳过本清理器
 */
export function normalizeKnowledgeAnswer(raw: string): string {
  let text = raw.trim();

  // 常见坏味道 1：正文后面再单独列一段“来源: ...”
  text = text.replace(SOURCES_BLOCK_RE, "");

  // 常见坏味道 2：把注入给模型的 source/id/title 元信息直接吐回来了
  text = text.replace(INTERNAL_META_LINE_RE, "");

  // 如果整行就是 [n] id=... source=...，再次兜底删掉
  text = text
    .split("\n")
    .filter((line) => !SOURCE_META_LINE_RE.test(line.trim()))
    .join("\n");

  // 收敛多余空行
  text = text.replace(EXCESS_BLANKS_RE, "\n\n").trim();

  return text;
}
