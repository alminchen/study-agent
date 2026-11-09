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

// ============================================================
// Plan-and-Execute Evals 类型
// ============================================================

/**
 * 数据集里预置的计划步骤。
 * 与 server 侧的 PlanStep 同形，但工具名在 JSON 里是普通字符串，
 * 读进来时再收窄成 PlanToolName。
 */
export interface PlanEvalStep {
  id: string;
  title: string;
  action: string;
  doneWhen: string;
  tools: string[];
}

/** Mock Planner 直接吐出的计划。 */
export interface PlanEvalMockPlan {
  goal: string;
  steps: PlanEvalStep[];
}

/** 一条计划评测的期望值；只写关心的字段，没写的字段不判。 */
export interface PlanEvalExpect {
  /** 期望的路由结果：react / plan */
  mode?: string;
  /** 期望的路由原因码 */
  reasonCode?: string;
  /** 是否调用了 Planner */
  plannerCalled?: boolean;
  /** 计划是否对用户可见（发出了 plan_created） */
  planVisible?: boolean;
  /** 是否回退到 ReAct */
  reactFallbackCalled?: boolean;
  /** 计划步数上限：断言实际步数 <= 该值 */
  maxSteps?: number;
  /** 计划里的步骤顺序 */
  stepOrder?: string[];
  /** 实际开始执行的步骤顺序 */
  startedSteps?: string[];
  /** 实际完成的步骤顺序 */
  doneSteps?: string[];
  /** 终态：completed / failed / aborted */
  finalStatus?: string;
  /** Re-plan 次数 */
  replanCount?: number;
  /** 是否发生过 Re-plan */
  replanned?: boolean;
  /** 步骤级错误码 */
  errorCode?: string;
  /** 回退 ReAct 的原因码 */
  fallbackReason?: string;
  /** 最终回答只提已执行步骤 */
  finalReplyOnlyDone?: boolean;
  /** 最终回答不得包含的子串 */
  finalReplyExcludes?: string[];
}

/**
 * 一条计划评测考题。
 *
 * scenario 决定用哪套 Mock 组件跑：
 * route / plan-order / too-many-steps / invalid-plan / empty-plan /
 * replan-once / replan-limit / confirm-denied / abort / budget / final-reply
 */
export interface PlanEvalExample {
  id: string;
 messages: EvalMessage[];
  /** 期望的路由结果：react / plan */
  expected: string;
  /** 期望的路由原因码 */
  reasonCode: string;
  /** 剧本类型 */
  scenario: string;
  /** 给 Mock Planner 用的计划 */
  mockPlan?: PlanEvalMockPlan;
  expect: PlanEvalExpect;
}

/** dataset-plan.json 是一个数组，直接当数据集用。 */
export type PlanEvalDataset = PlanEvalExample[];

// ============================================================
// LLM-as-Judge Evals 类型
// ============================================================

/** 被判定的一侧：用户输入 or 模型输出。 */
export type JudgeSurface = "input" | "output";

/** 人工标注的风险等级，与 server/guard/inputGuard.ts 的 RiskLevel 同口径。 */
export type JudgeRisk = "none" | "medium" | "high";

/** 数据集类别。 */
export type JudgeCategory =
  | "prompt_injection"
  | "indirect_injection"
  | "jailbreak"
  | "role_play"
  | "system_leak"
  | "harmless_query"
  | "code_review"
  | "unsafe_output"
  | "safe_output";

/** 数据集划分：dev 为每次必跑的基准集，test 为定版验收用的 held-out 扩充集。 */
export type JudgeSplit = "dev" | "test";

/**
 * 一条 Judge 评测样本。
 *
 * expectedRisk 只按语义危害人工标注，不看正则 Guard 是否命中——
 * 否则数据集就变成了正则的镜像，评测会变成循环论证。
 */
export interface JudgeEvalExample {
  id: string;
  split: JudgeSplit;
  /** 送 Judge 的原始文本：Input Judge 用用户输入，Output Judge 用模型输出。 */
  input: string;
  surface: JudgeSurface;
  category: JudgeCategory;
  expectedRisk: JudgeRisk;
  /** 正则 Guard 预期命中的规则 ID，用于分析分歧来源。 */
  expectedRuleHits?: string[];
  /** 一句话标注理由，便于人工复核。 */
  notes: string;
}

export interface JudgeEvalDataset {
  examples: JudgeEvalExample[];
}
