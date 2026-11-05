/**
 * 规则分类器：判断任务走 ReAct 还是 Plan-and-Execute。
 *
 * 刻意不调模型：结果是纯函数，12 条样本可离线断言，分类边界可解释。
 * 只读最后一条用户消息 + 显式 mode + searchDocs 开关，不读完整历史。
 */
import type { ClassifyResult, PlanMode } from "./types.js";

export interface ClassifyInput {
  userMessage: string;
  mode?: PlanMode;
  searchDocs?: boolean;
}

/** 顺序词只在"前半句动作 + 后半句依赖前者的动作"时才有意义。 */
const SEQUENTIAL_PATTERN = /(先|然后|再|接着|最后|之后|随后|接下来)/;
/** "先……再……" 这种显式先后结构，比单个顺序词更有说服力。 */
const SEQUENTIAL_PAIR_PATTERN = /先[^。！？]{1,40}(再|然后|最后|接着|之后)/;
const RESEARCH_PATTERN = /(查一下|查查|查资料|搜索|检索|调研|研究一下|看下资料|看下相关资料|读一下)/;
const PRODUCE_PATTERN = /(写一份|写个|起草|生成一份|输出一份|报告|对比|对比分析|给出建议|给出一个|修复计划|迁移步骤|通知|方案|建议)/;
const ARTIFACT_PATTERN = /(对比|比较|对比分析|报告|方案|建议|计划|迁移步骤|通知)/;
/** 天气/时间这类"单步只读工具"任务，即使出现顺序词也不值得进 Planner。 */
const SINGLE_TOOL_HINT_PATTERN = /(天气|气温|温度|几点|什么时间|现在时间|日期|几号)/;
/** 增加顺序词可信度的能力域：检索/产出/多步推理。 */
const MULTI_CAPABILITY_HINT_PATTERN = /(查一下|查查|检索|搜索|调研|研究一下|写|生成|起草|对比|比较|分析|诊断|修复|迁移|部署)/;

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export function classifyTask(input: ClassifyInput): ClassifyResult {
  const text = input.userMessage.trim();
  if (input.mode === "react") {
    return { mode: "react", reasonCode: "explicit_react", signals: ["mode=react"] };
  }
  if (input.mode === "plan") {
    return { mode: "plan", reasonCode: "explicit_plan", signals: ["mode=plan"] };
  }
  if (!text) {
    return { mode: "react", reasonCode: "too_ambiguous", signals: ["empty_message"] };
  }

  const signals: string[] = [];
  if (input.searchDocs) signals.push("search_docs=on");

  const hasResearch = RESEARCH_PATTERN.test(text);
  const hasProduce = PRODUCE_PATTERN.test(text);
  const hasArtifact = ARTIFACT_PATTERN.test(text);
  const hasSequentialPair = SEQUENTIAL_PAIR_PATTERN.test(text);
  const hasSequential = SEQUENTIAL_PATTERN.test(text);
  const hasMultiCapability = MULTI_CAPABILITY_HINT_PATTERN.test(text);

  if (hasResearch) signals.push("research_action");
  if (hasProduce) signals.push("produce_artifact");
  if (hasArtifact) signals.push("artifact_request");
  if (hasSequentialPair) signals.push("sequential_pair");
  if (hasSequential) signals.push("sequential_keyword");
  if (hasMultiCapability) signals.push("multi_capability");

  // A. 先调研再产出：最典型的 Plan-and-Execute 场景。
  if (hasResearch && hasProduce) {
    return { mode: "plan", reasonCode: "research_then_produce", signals: uniq(signals) };
  }

  // B. 显式 "先……再……" 且没有强产出物（"最后总结"不是产出物）：
  //    走 sequential_keywords 而不是 artifact_request。
  if (hasSequentialPair && !hasProduce) {
    return { mode: "plan", reasonCode: "sequential_keywords", signals: uniq(signals) };
  }

  // C. 显式产出物 + 顺序词/对比，"先分析原因，再给出修复计划" / "对比并生成迁移步骤"。
  if (hasArtifact && (hasSequential || hasProduce)) {
    return { mode: "plan", reasonCode: "artifact_request", signals: uniq(signals) };
  }

  // D. 多能力 + 顺序词（且不是单步天气/时间这类只读工具任务）。
  const isSingleToolTask = SINGLE_TOOL_HINT_PATTERN.test(text) && !hasArtifact && !hasProduce && !hasResearch;
  if (hasSequential && hasMultiCapability && !isSingleToolTask) {
    return { mode: "plan", reasonCode: "multi_capability", signals: uniq(signals) };
  }

  signals.push("single_step_or_ambiguous");
  return { mode: "react", reasonCode: "single_step", signals: uniq(signals) };
}
