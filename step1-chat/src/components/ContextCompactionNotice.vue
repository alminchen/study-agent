<script setup lang="ts">
/**
 * 上下文压缩提示。
 *
 * 一行结论 + 可展开的四类摘要条目。
 * 只显示条目文本，不显示模型生成摘要时的推理过程——那是服务端内部的事。
 */
import { computed, ref } from "vue";
import type { ContextCompactionEvent } from "../types";

const props = defineProps<{
  /** 最近一次请求的压缩事件；为 null 表示本轮没有发生压缩。 */
  event: ContextCompactionEvent | null;
}>();

const expanded = ref(false);

const title = computed(() => {
  const event = props.event;
  if (!event) return "";
  const rounds = `${event.compactedRounds} 轮`;
  const tokens = `${formatTokens(event.originalTokens)} → ${formatTokens(
    event.compactedTokens,
  )} token`;
  return `已压缩 ${rounds}对话（估算 ${tokens}）`;
});

/** 四类摘要条目；顺序固定：约束 → 事实 → 决定 → 未决。 */
const groups = computed(() => {
  const summary = props.event?.summary ?? null;
  if (!summary) return [];
  return [
    {
      key: "constraints",
      label: "用户约束",
      items: summary.userConstraints.map((item) => item.text),
    },
    {
      key: "facts",
      label: "事实",
      items: summary.facts.map((fact) => `${fact.key}：${fact.value}`),
    },
    {
      key: "decisions",
      label: "决定",
      items: summary.decisions.map((item) => item.text),
    },
    {
      key: "unresolved",
      label: "未决事项",
      items: summary.unresolved.map((item) => item.text),
    },
  ].filter((group) => group.items.length > 0);
});

/** 摘要失败（degraded）时没有条目可展开，按钮退化成纯提示。 */
const canExpand = computed(() => !props.event?.degraded && groups.value.length > 0);

function formatTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

function toggle() {
  if (!canExpand.value) return;
  expanded.value = !expanded.value;
}
</script>

<template>
  <section v-if="event" class="compaction-notice" aria-label="上下文压缩">
    <button
      class="compaction-head"
      type="button"
      :aria-expanded="canExpand ? expanded : undefined"
      :disabled="!canExpand"
      @click="toggle"
    >
      <span class="compaction-title">{{ title }}</span>
      <span v-if="event.degraded" class="compaction-badge">本轮未启用摘要</span>
      <span v-else-if="canExpand" class="compaction-toggle">
        {{ expanded ? "收起" : "展开" }}
      </span>
    </button>
    <div v-if="canExpand && expanded" class="compaction-groups">
      <div v-for="group in groups" :key="group.key" class="compaction-group">
        <div class="compaction-group-label">{{ group.label }}</div>
        <ul class="compaction-items">
          <li
            v-for="(item, index) in group.items"
            :key="index"
            class="compaction-item"
          >
            {{ item }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.compaction-notice {
  flex: none;
  margin: 0 0 8px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: #ffffff;
  font-size: 12px;
  color: var(--text);
}

.compaction-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* 没有可展开内容时退化成纯提示，不该看起来像能点。 */
.compaction-head:disabled {
  cursor: default;
}

.compaction-title {
  font-weight: 600;
  /* 窄屏下 token 数字可能很长，允许在任意位置换行而不是撑破容器。 */
  overflow-wrap: anywhere;
}

.compaction-badge {
  color: var(--danger);
}

.compaction-toggle {
  margin-left: auto;
  color: var(--muted);
}

.compaction-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.compaction-group-label {
  margin-bottom: 2px;
  color: var(--muted);
}

.compaction-items {
  margin: 0;
  padding-left: 16px;
}

.compaction-item {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
