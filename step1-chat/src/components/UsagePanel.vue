<script setup lang="ts">
import { computed } from "vue";
import type { UsageSnapshot, UsageSummary } from "../types";

const props = defineProps<{
  lastUsage: UsageSnapshot | null;
  summary: UsageSummary | null;
  serverMode: "mock" | "api" | "unknown";
}>();

const showPanel = computed(() => props.serverMode === "api" && (props.lastUsage || props.summary));

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.000001) return "<$0.000001";
  return `$${usd.toFixed(6)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}
</script>

<template>
  <section v-if="showPanel" class="usage-panel" aria-label="Token 用量">
    <header class="trace-header">Token / 成本（估算）</header>
    <div v-if="lastUsage" class="usage-block">
      <div class="usage-title">本轮</div>
      <div class="usage-row">
        <span class="usage-label">LLM 调用</span>
        <span>{{ lastUsage.llmCalls }} 次</span>
      </div>
      <div class="usage-row">
        <span class="usage-label">Token</span>
        <span>
          输入 {{ formatTokens(lastUsage.promptTokens) }} · 输出
          {{ formatTokens(lastUsage.completionTokens) }} · 合计
          {{ formatTokens(lastUsage.totalTokens) }}
        </span>
      </div>
      <div class="usage-row">
        <span class="usage-label">估算成本</span>
        <span>{{ formatCost(lastUsage.estimatedCostUsd) }}</span>
      </div>
    </div>
    <div v-if="summary && summary.totalRequests > 0" class="usage-block usage-total">
      <div class="usage-title">累计（{{ summary.totalRequests }} 次请求）</div>
      <div class="usage-row">
        <span class="usage-label">总 Token</span>
        <span>{{ formatTokens(summary.totalTokens) }}</span>
      </div>
      <div class="usage-row">
        <span class="usage-label">总估算成本</span>
        <span>{{ formatCost(summary.totalCostUsd) }}</span>
      </div>
    </div>
    <p class="usage-note">成本为按模型单价的估算值，非平台真实账单。</p>
  </section>
</template>
