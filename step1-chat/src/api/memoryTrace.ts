/**
 * 记忆过程事件的解析器。
 *
 * 服务端四个链路（multi / plan / rag / structured）发出的记忆事件形状完全一致
 * （见 server/memory/types.ts 的 MemoryTraceEvent）：
 *   - memory_injected：这轮注入了哪几条
 *   - memory_extracted：这轮记住了什么
 *   - memory_failed：记忆链路某一步挂了（不影响聊天）
 *
 * 为什么单独抽一个文件：四条链路的 SSE 解析各写一遍，
 * 迟早会出现「一条链路漏了 memory_failed」这种漂移。
 * 这里只认一份协议，各链路调用同一个函数。
 */
import type { ToolTraceStep } from "../types";

/** 服务端可能发来的记忆事件（字段全部可选，脏数据一律降级而不是崩掉）。 */
interface RawMemoryEvent {
  type?: unknown;
  itemIds?: unknown;
  tokens?: unknown;
  items?: unknown;
  candidates?: unknown;
  stored?: unknown;
  stage?: unknown;
  message?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 把一条 SSE 事件解析成记忆 trace 步骤。
 *
 * 返回 null 表示「这不是记忆事件」，调用方直接跳过。
 */
export function parseMemoryTraceStep(event: RawMemoryEvent): ToolTraceStep | null {
  if (event.type === "memory_injected") {
    const items = Array.isArray(event.items)
      ? event.items
          .filter((item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
          )
          .filter((item) => Boolean(item.id))
          .map((item) => ({
            id: asString(item.id),
            key: asString(item.key),
            value: asString(item.value),
            similarity: typeof item.similarity === "number" ? item.similarity : 0,
          }))
      : [];
    const itemIds = Array.isArray(event.itemIds) ? event.itemIds : [];
    return {
      kind: "memory_injected",
      // 没有明细时退回数：至少还能告诉用户「注入了几条」。
      count: items.length || itemIds.length,
      tokens: typeof event.tokens === "number" ? event.tokens : 0,
      items,
    };
  }

  if (event.type === "memory_extracted") {
    const stored = Array.isArray(event.stored)
      ? event.stored.map((item) => {
          const row = (item ?? {}) as Record<string, unknown>;
          return {
            id: asString(row.id),
            key: asString(row.key),
            value: asString(row.value),
          };
        })
      : [];
    return {
      kind: "memory_extracted",
      candidates: typeof event.candidates === "number" ? event.candidates : 0,
      stored,
    };
  }

  if (event.type === "memory_failed") {
    const stage = asString(event.stage);
    return {
      kind: "memory_failed",
      stage:
        stage === "retrieve" || stage === "extract" || stage === "store"
          ? stage
          : "retrieve",
      message: asString(event.message) || "记忆链路异常",
    };
  }

  return null;
}
