<script setup lang="ts">
import { computed } from "vue";
import type {
  ContextCompactionEvent,
  UsageScopeSummary,
  UsageSnapshot,
  UsageSummary,
} from "../types";

const props = defineProps<{
  lastUsage: UsageSnapshot | null;
  summary: UsageSummary | null;
  serverMode: "mock" | "api" | "unknown";
  /** 最近一次请求的上下文压缩事件；没有压缩时为 null。 */
  compaction?: ContextCompactionEvent | null;
}>();

/** USD → 人民币汇率（写死的估算汇率，实际账单以平台为准）。 */
const USD_TO_CNY = 7.2;

const showPanel = computed(() => props.serverMode === "api" && (props.lastUsage || props.summary));

/** 服务端存的是美元估算值，展示时按写死汇率折成人民币。 */
function formatCost(usd: number): string {
  const cny = usd * USD_TO_CNY;
  if (cny === 0) return "¥0";
  if (cny < 0.000001) return "<¥0.000001";
  return `¥${cny.toFixed(6)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 空口径兜底：服务端版本较旧、还没有 today 字段时不至于渲染报错。 */
const EMPTY_SCOPE: UsageScopeSummary = {
  totalRequests: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  byEndpoint: {},
  byModel: {},
};

/** 全部 / 当天两个模块共用同一套行结构，保证口径可直接对比。 */
function scopeRows(scope: UsageScopeSummary | undefined) {
  const data = scope ?? EMPTY_SCOPE;
  return [
    { label: "请求数", value: `${data.totalRequests} 次` },
    {
      label: "Token",
      value:
        `输入 ${formatTokens(data.totalPromptTokens)} · 输出 ` +
        `${formatTokens(data.totalCompletionTokens)} · 合计 ` +
        `${formatTokens(data.totalTokens)}`,
    },
    { label: "估算成本", value: formatCost(data.totalCostUsd) },
  ];
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
      <!-- 上下文压缩：本轮没有发生压缩就不显示这一行。 -->
      <div v-if="compaction" class="usage-row">
        <span class="usage-label">上下文压缩</span>
        <span>
          {{ formatTokens(compaction.originalTokens) }} →
          {{ formatTokens(compaction.compactedTokens) }} token
          <template v-if="compaction.summaryTokens > 0">
            （摘要 {{ formatTokens(compaction.summaryTokens) }}）
          </template>
        </span>
      </div>
    </div>
    <!-- 汇总按时间口径拆成两个模块：全部 / 当天 -->
    <div v-if="summary" class="usage-block usage-scope">
      <div class="usage-title">全部</div>
      <div v-for="row in scopeRows(summary)" :key="row.label" class="usage-row">
        <span class="usage-label">{{ row.label }}</span>
        <span>{{ row.value }}</span>
      </div>
    </div>
    <div v-if="summary" class="usage-block usage-scope">
      <div class="usage-title">当天</div>
      <div v-for="row in scopeRows(summary.today)" :key="row.label" class="usage-row">
        <span class="usage-label">{{ row.label }}</span>
        <span>{{ row.value }}</span>
      </div>
    </div>
    <p class="usage-note">成本为按模型单价估算并按 1 USD ≈ ¥7.2 折算，非平台真实账单。</p>
  </section>
</template>
