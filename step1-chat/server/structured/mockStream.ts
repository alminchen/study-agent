/**
 * 结构化输出的固定 fixture 回放器。
 *
 * Mock 只替换文本 chunk 来源，后续仍使用真实 accumulator、parser 和 SSE 协议，
 * 用于在没有 API Key 时验证页面状态和事件顺序。
 */
import { getPartialJsonFixture } from "./fixtures/partial-json.js";
import type { StructuredTarget } from "./types.js";

const DEFAULT_MOCK_INTERVAL_MS = 120;

/**
 * 表格 fixture 在列骨架、第一行、第二行完成时分别形成稳定快照。
 * 切点来自 fixture 内容，避免另抄一份完整 JSON。
 */
function buildTableChunks(): readonly string[] {
  // 从完整 fixture 反推切点，避免 Mock 数据和最终 schema 维护两份文本。
  const raw = getPartialJsonFixture("complete-table").raw;
  const rowsStart = raw.indexOf('"rows"');
  const secondRowStart = raw.indexOf('["B"');

  if (rowsStart < 0 || secondRowStart < 0) {
    throw new Error("complete-table fixture 缺少预期切分位置");
  }

  return [
    raw.slice(0, rowsStart),
    raw.slice(rowsStart, secondRowStart),
    raw.slice(secondRowStart),
  ];
}

function buildCodeChunks(): readonly string[] {
  // 代码只切一次，确保快照覆盖“标题/语言完成”和“正文完整”两个阶段。
  const raw = getPartialJsonFixture("complete-code").raw;
  const contentStart = raw.indexOf('"content"');

  if (contentStart < 0) {
    throw new Error("complete-code fixture 缺少 content 字段");
  }

  return [raw.slice(0, contentStart), raw.slice(contentStart)];
}

const TABLE_CHUNKS = buildTableChunks();
const CODE_CHUNKS = buildCodeChunks();

export function getMockStructuredChunks(
  target: StructuredTarget,
): readonly string[] {
  // 返回只读数组，调用方不能修改模块级 fixture 切分结果。
  return target === "table" ? TABLE_CHUNKS : CODE_CHUNKS;
}

/** Mock 回放参数；onChunk 与真实模型流共用同一回调形状。 */
export interface StreamMockStructuredChunksOptions {
  /** 选择 table/code fixture。 */
  target: StructuredTarget;
  /** 路由断开时停止等待并返回 aborted。 */
  signal: AbortSignal;
  /** 每次按固定间隔交付一个累计文本片段。 */
  onChunk: (chunk: string) => void;
  /** 可覆盖测试间隔；0 表示同步连续发送。 */
  intervalMs?: number;
}

/** Mock 只有完成和中止两种终态，不存在 provider 错误。 */
export type MockStructuredStreamResult = "completed" | "aborted";

/** 终止后立刻清理定时器，避免路由已断开仍继续发送 chunk。 */
function waitForNextChunk(
  intervalMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  // interval=0 时直接继续；其余情况等待定时器或 abort 中先发生的一项。
  if (signal.aborted) return Promise.resolve(false);
  if (intervalMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const finish = (shouldContinue: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(shouldContinue);
    };
    const timer = setTimeout(() => finish(true), intervalMs);
    const onAbort = () => finish(false);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 按固定间隔回放 fixture chunk。
 * 返回值用于路由区分正常结束和客户端中止；函数本身不写 SSE。
 */
export async function streamMockStructuredChunks(
  options: StreamMockStructuredChunksOptions,
): Promise<MockStructuredStreamResult> {
  // Mock 只模拟文本 chunk 到达节奏；partial parse 和 SSE 仍走真实实现。
  const chunks = getMockStructuredChunks(options.target);
  const intervalMs = Math.max(
    0,
    options.intervalMs ?? DEFAULT_MOCK_INTERVAL_MS,
  );

  for (let index = 0; index < chunks.length; index += 1) {
    // 第一个 chunk 立即发送，后续 chunk 之间保留可观察的流式间隔。
    if (index > 0 && !(await waitForNextChunk(intervalMs, options.signal))) {
      return "aborted";
    }
    if (options.signal.aborted) return "aborted";
    options.onChunk(chunks[index]);
  }

  return "completed";
}
