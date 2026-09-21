import type express from "express";
import type { UsageAccumulator } from "../usage/accumulator.js";
import { appendUsageRecord } from "../usage/store.js";
import type { UsageRecord } from "../usage/types.js";

/** 声明 SSE 响应头（浏览器按块读 data: 行） */
export function setSseHeaders(res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

/**
 * SSE 路径写 Token 用量：合成 UsageRecord → 落盘 → 推 { type:"usage", ... } 事件。
 * Mock / 检索判空未调 LLM 时 accumulator.isEmpty，直接跳过。
 * 调用方：/api/chat、/api/chat/multi、/api/rag/chat。
 */
export function writeUsageToStream(
  res: express.Response,
  accumulator: UsageAccumulator,
  endpoint: UsageRecord["endpoint"],
  defaultModel: string,
): void {
  if (accumulator.isEmpty || res.writableEnded) return;
  const record = accumulator.toRecord(endpoint, defaultModel);
  appendUsageRecord(record);
  res.write(`data: ${JSON.stringify({ type: "usage", ...record })}\n\n`);
}
