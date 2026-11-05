/**
 * 解析并校验请求体里带回来的 contextSummary。
 *
 * 摘要是**客户端可控的数据**（前端生成、前端持久化），所以它可能：
 * - 是旧版本结构（服务端不认）；
 * - 被用户手动改坏;
 * - 字段类型不对;
 * - 内容超长。
 *
 * 处理原则（决策四「失败就回退，不阻断聊天」）：
 * **任何非法都当作「没有摘要」**，不报错、不透传、不影响聊天继续。
 *
 * 但「逐字段校验」不等于「一坏全丢」：
 * - 结构性问题（不是对象、版本不对、某个分类不是数组）→ 整份丢弃；
 * - 单条内容有问题（某条 text 超长、缺 sourceMessageIndex）→ 只丢那一条，
 *   其余条目照常用。丢掉一条约束好过丢掉整段记忆。
 */
import { z } from "zod";
import { CONTEXT_SUMMARY_VERSION, type ContextSummary } from "./types.js";

/** 每个分类最多保留多少条。 */
const MAX_ITEMS = 60;
/** fact 的 key 最长多少字符。 */
const MAX_KEY_CHARS = 80;
/** fact 的 value / 普通条目的 text 最长多少字符。 */
const MAX_VALUE_CHARS = 300;
/** 消息 id 最长多少字符。 */
const MAX_MESSAGE_ID_CHARS = 200;
/** 来源下标的最大值（防止离谱的大数把数组下标搞乱）。 */
const MAX_SOURCE_INDEX = 100_000;

const sourceIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SOURCE_INDEX);

const itemSchema = z.object({
  text: z.string().max(MAX_VALUE_CHARS),
  sourceMessageIndex: sourceIndexSchema,
});

const factSchema = z.object({
  key: z.string().max(MAX_KEY_CHARS),
  value: z.string().max(MAX_VALUE_CHARS),
  sourceMessageIndex: sourceIndexSchema,
});

/**
 * 容器结构：分类字段只校验「是个数组、条数不超限」，
 * 数组内部每一条单独校验。
 */
const containerSchema = z.object({
  version: z.literal(CONTEXT_SUMMARY_VERSION),
  updatedAt: z.number().int().nonnegative(),
  compactedUntilMessageId: z.string().max(MAX_MESSAGE_ID_CHARS).nullish(),
  compactedUntilIndex: z.number().int().min(-1).max(MAX_SOURCE_INDEX).optional(),
  facts: z.array(z.unknown()).max(MAX_ITEMS),
  decisions: z.array(z.unknown()).max(MAX_ITEMS),
  unresolved: z.array(z.unknown()).max(MAX_ITEMS),
  userConstraints: z.array(z.unknown()).max(MAX_ITEMS),
});

/** 逐条过滤：只保留完全合法的条目，顺手把字符串两端空白去掉。 */
function keepValidItems(
  raw: unknown[],
  schema: z.ZodType<{ text: string; sourceMessageIndex: number }>,
): Array<{ text: string; sourceMessageIndex: number }> {
  const kept: Array<{ text: string; sourceMessageIndex: number }> = [];
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) continue;
    const text = parsed.data.text.trim();
    // 空文本没有任何信息量，丢掉它。
    if (text.length === 0) continue;
    kept.push({ ...parsed.data, text });
  }
  return kept;
}

/** 逐条过滤事实；key 空的丢掉，value 空的也丢掉（没有值的 fact 是噪声）。 */
function keepValidFacts(
  raw: unknown[],
): Array<{ key: string; value: string; sourceMessageIndex: number }> {
  const kept: Array<{ key: string; value: string; sourceMessageIndex: number }> = [];
  for (const entry of raw) {
    const parsed = factSchema.safeParse(entry);
    if (!parsed.success) continue;
    const key = parsed.data.key.trim();
    const value = parsed.data.value.trim();
    if (key.length === 0 || value.length === 0) continue;
    kept.push({ ...parsed.data, key, value });
  }
  return kept;
}

/**
 * 把请求体里的未知值解析成一份可信的摘要。
 *
 * @returns 合法时返回校验后的摘要；任何结构性问题都返回 null（当作没有摘要）。
 */
export function parseContextSummary(raw: unknown): ContextSummary | null {
  if (raw === null || raw === undefined) return null;

  const container = containerSchema.safeParse(raw);
  if (!container.success) {
    console.warn(
      `[context/parseContextSummary] 摘要结构不合法，按无摘要处理：${container.error.issues[0]?.message ?? "unknown"}`,
    );
    return null;
  }

  const data = container.data;
  return {
    version: data.version,
    updatedAt: data.updatedAt,
    compactedUntilMessageId: data.compactedUntilMessageId ?? null,
    ...(typeof data.compactedUntilIndex === "number"
      ? { compactedUntilIndex: data.compactedUntilIndex }
      : {}),
    facts: keepValidFacts(data.facts),
    decisions: keepValidItems(data.decisions, itemSchema),
    unresolved: keepValidItems(data.unresolved, itemSchema),
    userConstraints: keepValidItems(data.userConstraints, itemSchema),
  };
}
