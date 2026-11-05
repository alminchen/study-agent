<script setup lang="ts">
/**
 * 工具调用过程面板。
 *
 * 这里只渲染工具轨迹（tool_call / tool_result / pending_confirm / 防护事件）。
 * 计划步骤与 Re-plan 历史由 PlanTimeline 单独展示，两块面板互不混用数据源。
 */
import { computed } from "vue";
import type { ToolTraceStep } from "../types";

const props = defineProps<{
  steps: ToolTraceStep[];
  /** 正在流式时才允许点确认（会话仍挂着 wait） */
  confirmEnabled?: boolean;
}>();

const emit = defineEmits<{
  confirm: [payload: { confirmId: string; toolCallId: string; action: "allow" | "deny" }];
}>();

const hasSteps = computed(() => props.steps.length > 0);

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
  if (step.kind === "pending_confirm") {
    if (step.status === "pending" || step.status === "resolving") {
      return `等待确认 · ${step.name}`;
    }
    return `已确认（${step.status === "allow" ? "允许" : "拒绝"}）· ${step.name}`;
  }
  return `确认结果 · ${step.name}（${step.action === "allow" ? "允许" : "拒绝"}）`;
}

function payloadOf(step: ToolTraceStep): unknown {
  if (step.kind === "tool_call" || step.kind === "pending_confirm") return step.arguments;
  if (step.kind === "tool_result") return step.result;
  if (step.kind === "injection_detected") return { level: step.level, rules: step.rules };
  if (step.kind === "output_leak_blocked") return { matchedFingerprints: step.matchedFingerprints };
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
    <header class="trace-header">工具调用过程</header>
    <ol class="trace-list">
      <li
        v-for="(step, index) in steps"
        :key="`${step.kind}-${index}`"
        class="trace-item"
        :class="{ 'is-pending': step.kind === 'pending_confirm' && step.status === 'pending' }"
      >
        <div class="trace-title">{{ index + 1 }}. {{ titleOf(step) }}</div>
        <pre class="trace-json">{{ JSON.stringify(payloadOf(step), null, 2) }}</pre>
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
</style>
