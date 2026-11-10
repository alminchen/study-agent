<script setup lang="ts">
/**
 * 工具调用过程面板。
 *
 * 这里只渲染工具轨迹（tool_call / tool_result / pending_confirm / 防护事件）。
 * 计划步骤与 Re-plan 历史由 PlanTimeline 单独展示，两块面板互不混用数据源。
 *
 * Reflection 的三类事件（评分 / 重写 / 跳过）也在这里显示：
 * 「是否评分、是否重写、为什么停止」需要一眼可见；但 rubric 只出现在本面板，
 * 绝不写进回答正文。
 */
import { computed } from "vue";
import type { ToolTraceStep } from "../types";

const props = defineProps<{
  steps: ToolTraceStep[];
  /** 正在流式时才允许点确认（会话仍挂着 wait） */
  confirmEnabled?: boolean;
  /** 长期记忆开关；关掉时面板要说明「这一轮不会有记忆注入」。 */
  memoryEnabled?: boolean;
}>();

const emit = defineEmits<{
  confirm: [payload: { confirmId: string; toolCallId: string; action: "allow" | "deny" }];
}>();

const hasSteps = computed(() => props.steps.length > 0);

/** Reflection 跳过原因的中文说明；服务端枚举 → 人话。 */
const SKIP_REASON_TEXT: Record<string, string> = {
  off: "反思未启用",
  mock_mode: "Mock 模式不做反思",
  critique_failed: "评分失败",
  no_rewrite_needed: "分数达标，无需重写",
  revise_failed: "重写失败",
  revise_rejected: "重写结果不可信",
  revise_no_change: "重写没有改动",
  rescore_failed: "重评失败",
  no_improvement: "重写没有变好",
  shadow_mode: "影子模式不改答案",
};

/** 四维分数的中文标签；顺序与 rubric 一致。 */
const DIMENSION_TEXT: Record<string, string> = {
  relevance: "相关性",
  completeness: "完整性",
  groundedness: "有据性",
  clarity: "清晰度",
};

function skipReasonText(reason: string): string {
  return SKIP_REASON_TEXT[reason] ?? reason;
}

function dimensionText(dimension: string): string {
  return DIMENSION_TEXT[dimension] ?? dimension;
}

function titleOf(step: ToolTraceStep): string {
  if (step.kind === "tool_call") {
    return step.name === "searchDocs" ? `检索调用 ${step.name}` : `模型决定调用 ${step.name}`;
  }
  if (step.kind === "tool_result") return `工具执行结果 · ${step.name}`;
  if (step.kind === "injection_detected") {
    return `输入防护 · 疑似注入（${step.level ?? "unknown"}）`;
  }
  if (step.kind === "output_leak_blocked") {
    return "输出防护 · 已拦截 system/规则泄露";
  }
  if (step.kind === "judge_shadow") {
    const risk = step.judge.risk ?? "unknown";
    const confidence =
      typeof step.judge.confidence === "number" ? step.judge.confidence.toFixed(2) : "-";
    if (step.judge.status === "error") {
      return `LLM 判定 · 失败（${step.judge.errorKind ?? "unknown"}）`;
    }
    return `LLM 判定 · ${risk}（置信度 ${confidence}）`;
  }
  if (step.kind === "judge_enforced") {
    const scope = step.surface === "retrieval" ? "检索片段" : "输入";
    const action =
      step.action === "block" ? "已拦截" : step.action === "flag" ? "已标记" : "已放行";
    const risk = step.judge.risk ?? "unknown";
    return `LLM 判定 · ${scope} ${action}（${risk}）`;
  }
  if (step.kind === "pending_confirm") {
    if (step.status === "pending" || step.status === "resolving") {
      return `等待确认 · ${step.name}`;
    }
    return `已确认（${step.status === "allow" ? "允许" : "拒绝"}）· ${step.name}`;
  }
  if (step.kind === "reflection_scored") {
    const stage = step.stage === "revised" ? "重评" : "初评";
    return `自我评分 · ${stage}（均分 ${step.average.toFixed(1)}）`;
  }
  if (step.kind === "reflection_revised") {
    const adopted = step.adopted ? "已采纳修订稿" : "未采纳修订稿";
    return `自我重写 · ${adopted}（${step.beforeAverage.toFixed(1)} → ${step.afterAverage.toFixed(1)}）`;
  }
  if (step.kind === "reflection_skipped") {
    return `自我评估 · 跳过（${skipReasonText(step.reason)}）`;
  }
  if (step.kind === "memory_injected") {
    return `长期记忆 · 已注入 ${step.count} 条`;
  }
  if (step.kind === "memory_extracted") {
    return `长期记忆 · 记住了 ${step.stored.length} 条`;
  }
  return `确认结果 · ${step.name}（${step.action === "allow" ? "允许" : "拒绝"}）`;
}

function payloadOf(step: ToolTraceStep): unknown {
  if (step.kind === "tool_call" || step.kind === "pending_confirm") return step.arguments;
  if (step.kind === "tool_result") return step.result;
  if (step.kind === "injection_detected") return { level: step.level, rules: step.rules };
  if (step.kind === "output_leak_blocked") return { matchedFingerprints: step.matchedFingerprints };
  if (step.kind === "judge_shadow") {
    return {
      mode: step.mode,
      surface: step.surface,
      regexGuard: step.guard,
      judge: step.judge,
      meta: step.meta,
    };
  }
  if (step.kind === "judge_enforced") {
    return {
      mode: step.mode,
      surface: step.surface,
      action: step.action,
      label: step.label,
      reason: step.reason,
      disagree: step.disagree,
      regexGuard: step.guard,
      judge: step.judge,
      meta: step.meta,
    };
  }
  if (step.kind === "reflection_scored") {
    return {
      stage: step.stage,
      scores: step.scores,
      average: step.average,
      issues: step.issues,
      shouldRewrite: step.shouldRewrite,
      reason: step.reason,
      meta: step.meta,
    };
  }
  if (step.kind === "reflection_revised") {
    return {
      adopted: step.adopted,
      improved: step.improved,
      beforeAverage: step.beforeAverage,
      afterAverage: step.afterAverage,
      reason: step.reason,
    };
  }
  if (step.kind === "reflection_skipped") {
    return { reason: step.reason, detail: step.detail };
  }
  if (step.kind === "memory_injected") {
    return { count: step.count, tokens: step.tokens, items: step.items };
  }
  if (step.kind === "memory_extracted") {
    return { candidates: step.candidates, stored: step.stored };
  }
  return { action: step.action };
}

function canConfirm(step: ToolTraceStep): boolean {
  return (
    Boolean(props.confirmEnabled) &&
    step.kind === "pending_confirm" &&
    step.status === "pending"
  );
}

function onAllow(step: Extract<ToolTraceStep, { kind: "pending_confirm" }>) {
  emit("confirm", {
    confirmId: step.confirmId,
    toolCallId: step.toolCallId,
    action: "allow",
  });
}

function onDeny(step: Extract<ToolTraceStep, { kind: "pending_confirm" }>) {
  emit("confirm", {
    confirmId: step.confirmId,
    toolCallId: step.toolCallId,
    action: "deny",
  });
}
</script>

<template>
  <section v-if="hasSteps" class="trace-panel" aria-label="工具调用过程">
    <header class="trace-header">
      工具调用过程
      <!-- 记忆关着时给出说明，避免「没看到注入」被误当成 bug。 -->
      <span v-if="memoryEnabled === false" class="memory-off-hint">长期记忆已关闭</span>
    </header>
    <ol class="trace-list">
      <li
        v-for="(step, index) in steps"
        :key="`${step.kind}-${index}`"
        class="trace-item"
        :class="{ 'is-pending': step.kind === 'pending_confirm' && step.status === 'pending' }"
      >
        <div class="trace-title">{{ index + 1 }}. {{ titleOf(step) }}</div>
        <!-- 反思事件用可读版块展示：分数、是否重写、为什么停止一眼可见。 -->
        <div v-if="step.kind === 'reflection_scored'" class="reflection-body">
          <div class="reflection-scores">
            <span
              v-for="(value, key) in step.scores"
              :key="key"
              class="score-chip"
            >{{ dimensionText(String(key)) }} {{ value }}</span>
            <span class="score-chip">均分 {{ step.average.toFixed(1) }}</span>
          </div>
          <div class="reflection-line">
            {{ step.shouldRewrite ? "低于阈值，需要重写" : "达到阈值，不重写" }}
            <span class="reflection-stage">
              {{ step.stage === "revised" ? "重评" : "初评" }}
            </span>
          </div>
          <ul v-if="step.issues.length" class="reflection-issues">
            <li v-for="(issue, issueIndex) in step.issues" :key="issueIndex">
              {{ dimensionText(issue.dimension) }}：{{ issue.detail }}
            </li>
          </ul>
          <div v-if="step.reason" class="reflection-reason">{{ step.reason }}</div>
        </div>
        <div v-else-if="step.kind === 'reflection_revised'" class="reflection-body">
          <div class="reflection-line">
            {{ step.adopted ? "已用修订稿作为最终答案" : "保留初版答案" }} ·
            {{ step.improved ? "均分有提升" : "均分没有提升" }}
          </div>
          <div class="reflection-line">
            初版 {{ step.beforeAverage.toFixed(1) }} → 修订 {{ step.afterAverage.toFixed(1) }}
          </div>
          <div v-if="step.reason" class="reflection-reason">{{ step.reason }}</div>
        </div>
        <div v-else-if="step.kind === 'reflection_skipped'" class="reflection-body">
          <div class="reflection-line">{{ skipReasonText(step.reason) }}</div>
          <div v-if="step.detail" class="reflection-reason">{{ step.detail }}</div>
        </div>
        <!-- 记忆注入：展开能看到这一轮到底塞了哪几条、相似度多少。 -->
        <div v-else-if="step.kind === 'memory_injected'" class="reflection-body">
          <div class="reflection-line">
            已注入 {{ step.count }} 条，约 {{ step.tokens }} token
          </div>
          <ul v-if="step.items.length" class="reflection-issues">
            <li v-for="item in step.items" :key="item.id">
              {{ item.key }}={{ item.value }}
              <span class="similarity">相似度 {{ item.similarity.toFixed(2) }}</span>
            </li>
          </ul>
          <div v-else class="reflection-reason">本轮没有命中的长期记忆。</div>
        </div>
        <!-- 记忆抽取：这一轮从对话里存下了什么。 -->
        <div v-else-if="step.kind === 'memory_extracted'" class="reflection-body">
          <div class="reflection-line">
            候选 {{ step.candidates }} 条，实际保存 {{ step.stored.length }} 条
          </div>
          <ul v-if="step.stored.length" class="reflection-issues">
            <li v-for="item in step.stored" :key="item.id">
              {{ item.key }}={{ item.value }}
            </li>
          </ul>
        </div>
        <pre v-else class="trace-json">{{ JSON.stringify(payloadOf(step), null, 2) }}</pre>
        <div v-if="step.kind === 'pending_confirm'" class="confirm-actions">
          <template v-if="canConfirm(step)">
            <button type="button" class="confirm-btn allow" @click="onAllow(step)">允许执行</button>
            <button type="button" class="confirm-btn deny" @click="onDeny(step)">拒绝</button>
          </template>
          <span v-else-if="step.status === 'resolving'" class="confirm-hint">处理中…</span>
          <span v-else-if="step.status === 'allow'" class="confirm-hint ok">已允许</span>
          <span v-else-if="step.status === 'deny'" class="confirm-hint no">已拒绝</span>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.trace-item.is-pending {
  border-left: 3px solid #f59e0b;
  padding-left: 0.6rem;
}
.confirm-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.confirm-btn {
  font-size: 0.8rem;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
}
.confirm-btn.allow {
  background: #166534;
  color: #fff;
}
.confirm-btn.deny {
  background: #fff;
  color: #b91c1c;
  border-color: #fecaca;
}
.confirm-hint {
  font-size: 0.78rem;
  color: #64748b;
}
.confirm-hint.ok {
  color: #166534;
}
.confirm-hint.no {
  color: #b91c1c;
}
.reflection-body {
  margin-top: 0.35rem;
  font-size: 0.82rem;
  color: #475569;
}
.reflection-scores {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-bottom: 0.35rem;
}
.score-chip {
  background: #eef2ff;
  color: #3730a3;
  border-radius: 999px;
  padding: 0.1rem 0.55rem;
  font-size: 0.76rem;
}
.reflection-line {
  line-height: 1.6;
}
.reflection-stage {
  color: #94a3b8;
  margin-left: 0.3rem;
}
.reflection-issues {
  margin: 0.25rem 0 0;
  padding-left: 1.1rem;
  line-height: 1.6;
}
.reflection-reason {
  color: #64748b;
  margin-top: 0.2rem;
  line-height: 1.6;
}
.similarity {
  color: #94a3b8;
  margin-left: 0.35rem;
}
.memory-off-hint {
  margin-left: 0.5rem;
  font-size: 0.72rem;
  font-weight: 400;
  color: #b45309;
}
</style>
