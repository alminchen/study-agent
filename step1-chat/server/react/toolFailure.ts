/** 同一工具名连续失败几次后，不再执行该工具。与「问模型几次」分开。 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 2;

/** 约定：工具返回带字符串 `error` 字段就算失败（未知工具、白名单拒绝、抛错都走这个形状）。 */
export function isToolErrorResult(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  return "error" in result && typeof (result as { error: unknown }).error === "string";
}

/**
 * 一次用户问题内，按工具名累计连续失败。
 *
 * 成功会把该工具计数清零：中间查对了一次，再失败从 1 重新算。
 * 达上限后 isStopped 为 true，applyToolCalls 不再 run，只回填 stoppedResult。
 */
export function createConsecutiveFailureTracker() {
  const counts = new Map<string, number>();

  return {
    isStopped(toolName: string): boolean {
      return (counts.get(toolName) ?? 0) >= MAX_CONSECUTIVE_TOOL_FAILURES;
    },
    record(toolName: string, result: unknown): void {
      if (isToolErrorResult(result)) {
        counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
      } else {
        counts.set(toolName, 0);
      }
    },
    stoppedResult(toolName: string): { error: string } {
      return {
        error: `工具 ${toolName} 连续失败已达 ${MAX_CONSECUTIVE_TOOL_FAILURES} 次，已停止再执行。`,
      };
    },
  };
}

export type ConsecutiveFailureTracker = ReturnType<typeof createConsecutiveFailureTracker>;
