/** 一条 eval 考题：固定 messages + 知识库开关 + 期望。 */
export interface EvalMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EvalExpect {
  /** 轨迹里必须出现过的工具名（含 prefetch 的 searchDocs）。 */
  toolsInclude?: string[];
  /** 轨迹里不得出现的工具名。 */
  toolsExclude?: string[];
  /** 最终回复不得包含的子串。 */
  mustNotMatch?: string[];
  /** 默认 true：不得抛错（如 LLM 400）。 */
  mustSucceed?: boolean;
}

export interface EvalExample {
  id: string;
  messages: EvalMessage[];
  searchDocs: boolean;
  expect: EvalExpect;
}

export interface EvalDataset {
  examples: EvalExample[];
}

/** 跑完一条 Example 的原始结果，交给 evaluators 判分。 */
export interface EvalRunResult {
  id: string;
  output: string;
  /** 按调用顺序记录的工具名（同一工具可出现多次）。 */
  tools: string[];
  error: string | null;
}

export interface EvalVerdict {
  pass: boolean;
  reasons: string[];
}

// ============================================================
// 多 Agent Evals 类型
// ============================================================

/** 多 Agent eval 的期望：除了工具还验证路由决策 */
export interface MultiAgentEvalExpect {
  /** Supervisor 路由结果中必须包含的 Worker 名称 */
  routeIncludes?: string[];
  /** Supervisor 路由结果中不得包含的 Worker 名称 */
  routeExcludes?: string[];
  /** 所有 Worker 汇总后，调用过的工具中必须包含的 */
  toolsInclude?: string[];
  /** 所有 Worker 汇总后，调用过的工具中不得包含的 */
  toolsExclude?: string[];
  /** 最终回复不得包含的子串 */
  mustNotMatch?: string[];
  /** 不得抛错 */
  mustSucceed?: boolean;
}

export interface MultiAgentEvalExample {
  id: string;
  messages: EvalMessage[];
  expect: MultiAgentEvalExpect;
}

export interface MultiAgentEvalDataset {
  examples: MultiAgentEvalExample[];
}

/** 多 Agent eval 跑完一条的结果 */
export interface MultiAgentEvalRunResult {
  id: string;
  /** 最终汇总回复 */
  output: string;
  /** Supervisor 路由到了哪些 Worker */
  routedWorkers: string[];
  /** 所有 Worker 合计调用的工具 */
  tools: string[];
  error: string | null;
}
