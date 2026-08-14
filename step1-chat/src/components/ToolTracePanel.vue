<script setup lang="ts">
import { computed } from "vue";
import type { ToolTraceStep } from "../types";

const props = defineProps<{ steps: ToolTraceStep[] }>();

const hasSteps = computed(() => props.steps.length > 0);

function titleOf(step: ToolTraceStep): string {
  if (step.kind === "tool_call") return `模型决定调用 ${step.name}`;
  return `工具执行结果 · ${step.name}`;
}

function payloadOf(step: ToolTraceStep): unknown {
  return step.kind === "tool_call" ? step.arguments : step.result;
}
</script>

<template>
  <section v-if="hasSteps" class="trace-panel" aria-label="工具调用过程">
    <header class="trace-header">工具调用过程</header>
    <ol class="trace-list">
      <li v-for="(step, index) in steps" :key="`${step.kind}-${index}`" class="trace-item">
        <div class="trace-title">{{ index + 1 }}. {{ titleOf(step) }}</div>
        <pre class="trace-json">{{ JSON.stringify(payloadOf(step), null, 2) }}</pre>
      </li>
    </ol>
  </section>
</template>
