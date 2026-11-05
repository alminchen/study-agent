<script setup lang="ts">
/**
 * 计划时间线：展示「准备做什么、做到哪、为什么改计划」。
 *
 * 只读 state，不自己发请求：
 * - 步骤状态完全由 useChat 的 applyPlanEvent 归并结果驱动。
 * - Re-plan 的旧计划从 planHistory 里取，不覆盖当前计划。
 */
import { computed } from "vue";
import type {
  PlanErrorCode,
  PlanMode,
  PlanRuntimeState,
  PlanStepStateView,
} from "../types";

const props = defineProps<{
  state: PlanRuntimeState | null;
  /** 用户选择的模式（auto / react / plan），与服务端解析后的实际路由不同。 */
  requestedMode?: PlanMode;
}>();

/** 错误码到可读文案的映射；没有映射时回退到错误码本身，不展示堆栈。 */
const ERROR_TEXT: Record<PlanErrorCode, string> = {
  classify_failed: "任务分类失败",
  planner_failed: "生成计划失败",
  invalid_plan: "计划格式不合法",
  plan_empty: "计划为空",
  plan_too_long: "计划过长",
  step_turn_limit: "单步模型轮数超限",
  step_tool_limit: "单步工具调用超限",
  tool_not_allowed: "工具不在允许范围",
  tool_failed: "工具执行失败",
  confirm_denied: "用户拒绝了该操作",
  replan_limit: "已达重规划次数上限",
  model_budget_exhausted: "模型调用预算耗尽",
  aborted: "已中止",
  final_reply_failed: "生成最终回答失败",
};

const STATUS_TEXT: Record<PlanStepStateView["status"], string> = {
  pending: "等待",
  running: "执行中",
  done: "完成",
  failed: "失败",
  skipped: "未执行",
};

const REQUESTED_TEXT: Record<PlanMode, string> = {
  auto: "Auto（自动判断）",
  react: "ReAct（强制直答）",
  plan: "Plan（强制规划）",
};

/** 实际路由：服务端解析后是走计划还是走 ReAct。 */
const routeLabel = computed(() => {
  const route = props.state?.route;
  if (!route) return null;
  return route.mode === "plan" ? "本次走 Plan" : "本次走 ReAct";
});

const routeReason = computed(() => {
  const route = props.state?.route;
  if (!route) return null;
  const reasons: Record<string, string> = {
    explicit_react: "用户指定直答",
    explicit_plan: "用户指定规划",
    single_step: "单步任务",
    multi_capability: "需要多种能力",
    sequential_keywords: "含顺序性关键词",
    research_then_produce: "先调研再产出",
    artifact_request: "要求交付成品",
    too_ambiguous: "目标过于模糊",
  };
  return reasons[route.reasonCode] ?? route.reasonCode;
});

/** 当前生效的计划。 */
const plan = computed(() => props.state?.plan ?? null);

/** 步骤状态按当前计划顺序对齐；缺状态时视为等待。 */
const steps = computed(() => {
  const state = props.state;
  const current = plan.value;
  if (!state || !current || !Array.isArray(current.steps)) return [];
  return current.steps.map((step, index) => {
    const view = state.stepResults.find((row) => row.stepId === step.id);
    return {
      index: index + 1,
      id: step.id,
      title: step.title,
      action: step.action,
      doneWhen: step.doneWhen,
      tools: Array.isArray(step.tools) ? step.tools : [],
      status: view?.status ?? "pending",
      summary: view?.summary ?? "",
      errorCode: view?.errorCode,
    };
  });
});

/** Re-plan 之前的旧计划；当前计划不算历史。 */
const history = computed(() => {
  const all = props.state?.planHistory ?? [];
  return all.slice(0, Math.max(0, all.length - 1)).map((plan) => ({
    goal: plan.goal,
    steps: Array.isArray(plan.steps)
      ? plan.steps.map((step) => ({ id: step.id, title: step.title }))
      : [],
  }));
});

const finishText = computed(() => {
  const status = props.state?.finishedStatus;
  if (!status) return null;
  if (status === "completed") return "计划已执行完成";
  if (status === "aborted") return "计划已中止";
  return "计划执行失败";
});

function statusText(status: PlanStepStateView["status"]): string {
  return STATUS_TEXT[status];
}

function errorText(code?: PlanErrorCode): string | null {
  if (!code) return null;
  return ERROR_TEXT[code] ?? code;
}
</script>

<template>
  <section v-if="state" class="plan-panel" aria-label="计划执行时间线">
    <header class="plan-header">
      <span>执行计划</span>
      <span class="plan-badges">
        <span class="plan-badge">{{ REQUESTED_TEXT[requestedMode ?? "auto"] }}</span>
        <span v-if="routeLabel" class="plan-badge route">{{ routeLabel }}</span>
        <span v-if="state.revision > 0" class="plan-badge revision">
          v{{ state.revision }}
        </span>
      </span>
    </header>

    <div class="plan-body">
      <!-- 路由原因：说明为什么进计划或回退直答。 -->
      <p v-if="routeReason" class="plan-reason">判定依据：{{ routeReason }}</p>

      <!-- 回退提示：计划不可用时的可读原因。 -->
      <p v-if="state.fallback" class="plan-fallback">
        已回退到 ReAct：{{ errorText(state.fallback.reasonCode) ?? state.fallback.reasonCode }}
        <span class="plan-fallback-detail">{{ state.fallback.message }}</span>
      </p>

      <!-- 目标：计划要交付什么。 -->
      <p v-if="plan" class="plan-goal">{{ plan.goal }}</p>

      <!-- Re-plan 历史：折叠展示旧计划，不覆盖当前计划。 -->
      <details v-if="history.length" class="plan-history">
        <summary>历史计划（{{ history.length }} 个旧版本）</summary>
        <div v-for="(old, index) in history" :key="`old-${index}`" class="plan-old">
          <p class="plan-old-goal">{{ old.goal }}</p>
          <ol class="plan-old-steps">
            <li v-for="step in old.steps" :key="step.id">
              {{ step.id }} · {{ step.title }}
            </li>
          </ol>
        </div>
      </details>

      <!-- 步骤：序号、标题、动作、完成条件、状态。 -->
      <ol v-if="steps.length" class="plan-steps">
        <li
          v-for="step in steps"
          :key="step.id"
          class="plan-step"
          :class="[`is-${step.status}`, { 'is-current': step.status === 'running' }]"
        >
          <div class="plan-step-head">
            <span class="plan-step-index">{{ step.index }}</span>
            <span class="plan-step-title">{{ step.title }}</span>
            <span class="plan-step-status">{{ statusText(step.status) }}</span>
          </div>
          <p class="plan-step-action">{{ step.action }}</p>
          <p class="plan-step-done">
            <span class="plan-step-label">完成条件</span>
            {{ step.doneWhen }}
          </p>
          <p v-if="step.tools.length" class="plan-step-tools">
            工具：{{ step.tools.join("、") }}
          </p>
          <p v-if="step.summary" class="plan-step-summary">{{ step.summary }}</p>
          <p v-if="step.errorCode" class="plan-step-error">
            失败原因：{{ errorText(step.errorCode) ?? step.errorCode }}
          </p>
        </li>
      </ol>

      <!-- 终态：完成 / 失败 / 中止。 -->
      <p v-if="finishText" class="plan-finish" :class="`is-${state.finishedStatus}`">
        {{ finishText }}
      </p>
      <!-- 计划级失败：Re-plan 未被采纳等，说明为什么整份计划停在这里。 -->
      <p v-if="state.planError" class="plan-finish is-failed">
        {{ errorText(state.planError.code) ?? state.planError.code }}：{{ state.planError.message }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.plan-panel {
  flex: none;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #ffffff;
  overflow: hidden;
}

.plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}

.plan-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.plan-badge {
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
  white-space: nowrap;
}

.plan-badge.route {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
}

.plan-badge.revision {
  border-color: #fde68a;
  background: #fffbeb;
  color: #b45309;
}

.plan-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-reason,
.plan-fallback {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.plan-fallback {
  padding: 6px 8px;
  border-radius: 6px;
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #9a3412;
}

.plan-fallback-detail {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: #b45309;
  overflow-wrap: anywhere;
}

.plan-goal {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--text);
  overflow-wrap: anywhere;
}

.plan-history {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
}

.plan-history summary {
  cursor: pointer;
  color: var(--muted);
}

.plan-old {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.plan-old-goal {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.plan-old-steps {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #64748b;
}

.plan-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-step {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
}

.plan-step.is-running {
  border-left-color: #2563eb;
  background: #f8fbff;
}

.plan-step.is-done {
  border-left-color: #16a34a;
}

.plan-step.is-failed {
  border-left-color: #dc2626;
}

.plan-step.is-skipped {
  opacity: 0.65;
}

.plan-step-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.plan-step-index {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--line);
  color: var(--muted);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.plan-step.is-running .plan-step-index {
  background: #2563eb;
  color: #fff;
}

.plan-step-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.plan-step-status {
  flex: none;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.plan-step-action,
.plan-step-done,
.plan-step-tools,
.plan-step-summary,
.plan-step-error {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #475569;
  overflow-wrap: anywhere;
}

.plan-step-done {
  color: #64748b;
}

.plan-step-label {
  margin-right: 4px;
  color: var(--muted);
}

.plan-step-tools {
  color: #64748b;
}

.plan-step-summary {
  color: #166534;
}

.plan-step-error {
  color: #b91c1c;
}

.plan-finish {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
}

.plan-finish.is-completed {
  color: #166534;
}

.plan-finish.is-failed {
  color: #b91c1c;
}

.plan-finish.is-aborted {
  color: #b45309;
}
</style>
