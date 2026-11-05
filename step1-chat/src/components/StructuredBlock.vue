<script setup lang="ts">
import { computed } from "vue";
import type {
  StructuredMessageState,
  StructuredResult,
  StructuredSnapshot,
  StructuredTarget,
} from "../types";

/**
 * 只负责把当前稳定快照或最终结果渲染成表格/代码块。
 * 请求状态、历史持久化和 revision 去重由上层负责。
 */
const props = defineProps<{
  /** 生成中的稳定快照；status=streaming 且尚无快照时为空。 */
  snapshot?: StructuredSnapshot | null;
  /** 最终结果；一旦存在就优先于 snapshot，避免完成态短暂回退。 */
  result?: StructuredResult | null;
  /** 上层消息状态机；本组件只负责视觉表达。 */
  status: StructuredMessageState["status"];
  /** 尚无 block 时用 target 决定骨架形状。 */
  target: StructuredTarget;
}>();

// 最终结果优先；否则使用最后一个稳定快照。
const block = computed(() => props.result?.block ?? props.snapshot?.block ?? null);
/** 代码骨架宽度写死为有限视觉节奏，不参与业务数据。 */
const SKELETON_CODE_WIDTHS = [76, 92, 58, 84, 46];

/** 每个表格列至少保留 144px，内容区通过横向滚动避免列被压扁。 */
function tableMinWidth(columnCount: number): string {
  return `${Math.max(1, columnCount) * 144}px`;
}
</script>

<template>
  <!-- 有 block 时按 table/code 渲染真实内容。 -->
  <div v-if="block" class="structured-block" :aria-busy="status === 'streaming'">
    <div class="structured-title">{{ block.title }}</div>

    <!-- 表格固定列宽布局，完整单元格文本由 CSS 自动换行。 -->
    <div v-if="block.kind === 'table'" class="table-scroll">
      <table :style="{ minWidth: tableMinWidth(block.columns.length) }">
        <thead>
          <tr>
            <th v-for="(column, columnIndex) in block.columns" :key="columnIndex">
              {{ column }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
            <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 代码块只做纯文本展示，不在浏览器执行模型生成内容。 -->
    <div v-else class="code-shell">
      <span class="code-language">{{ block.language || "text" }}</span>
      <pre><code>{{ block.content }}</code></pre>
    </div>
  </div>

  <!-- 生成中但还没有稳定 block 时，显示与 target 对应的骨架。 -->
  <div
    v-else-if="status === 'streaming'"
    class="structured-skeleton"
    aria-hidden="true"
  >
    <span class="skeleton-title" />
    <div v-if="target === 'table'" class="skeleton-table">
      <div
        v-for="row in 4"
        :key="row"
        class="skeleton-row"
        :class="{ header: row === 1 }"
      >
        <span v-for="column in 3" :key="column" />
      </div>
    </div>
    <div v-else class="skeleton-code">
      <span
        v-for="(width, index) in SKELETON_CODE_WIDTHS"
        :key="index"
        :style="{ width: `${width}%` }"
      />
    </div>
  </div>

  <!-- 非 streaming 且没有可展示内容时，给出稳定的空状态。 -->
  <div v-else class="structured-empty">
    没有收到可展示的完整内容
  </div>
</template>

<style scoped>
/* 最外层只负责宽度约束，不重复上层消息气泡样式。 */
.structured-block {
  width: 100%;
  min-width: 0;
  max-width: 100%;
}

/* 标题允许长中文和连续字符换行，避免撑破气泡。 */
.structured-title {
  margin-bottom: 8px;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* 横向滚动容器把宽表格限制在消息气泡内部。 */
.table-scroll {
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
}

/* table-layout=fixed 让列宽稳定，单元格内容只在自身范围内换行。 */
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
}

/* 表格单元格保留原始空白，同时允许任意长 token 换行。 */
th,
td {
  min-width: 0;
  padding: 7px 9px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* 表头使用浅色背景，和正文数据行形成清晰层级。 */
th {
  background: #f3f4f6;
  font-weight: 600;
}

/* 最后一列/行去掉重复边框，避免容器出现双线。 */
tr:last-child td {
  border-bottom: 0;
}

th:last-child,
td:last-child {
  border-right: 0;
}

/* 代码容器使用深色背景，语言标签与正文共用等宽字体。 */
.code-shell {
  position: relative;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid #334155;
  border-radius: 6px;
  background: #0f172a;
  color: #e2e8f0;
}

.code-language {
  display: block;
  padding: 5px 10px;
  border-bottom: 1px solid #334155;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}

/* 代码正文保留换行和缩进，超长行只在容器内横向滚动。 */
pre {
  max-width: 100%;
  margin: 0;
  padding: 12px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
  tab-size: 2;
}

code {
  font: inherit;
  white-space: pre;
}

/* 骨架和空状态共用卡片轮廓，但内容由不同子元素填充。 */
.structured-skeleton,
.structured-empty {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #ffffff;
}

.structured-skeleton {
  padding: 12px;
}

.skeleton-title,
.skeleton-row span,
.skeleton-code span {
  display: block;
  border-radius: 4px;
  background: #e8edf2;
  animation: skeleton-pulse 1.4s ease-in-out infinite;
}

.skeleton-title {
  width: 38%;
  height: 13px;
  margin-bottom: 12px;
}

.skeleton-table {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 5px;
}

/* 表格骨架固定三列，真实列数要等 columns 完整后才出现。 */
.skeleton-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.skeleton-row + .skeleton-row {
  border-top: 1px solid var(--line);
}

.skeleton-row span {
  height: 10px;
  margin: 11px 10px;
}

.skeleton-row.header {
  background: #f3f6f8;
}

.skeleton-row.header span {
  background: #dce4ea;
}

/* 代码骨架用不同宽度的占位线模拟代码行。 */
.skeleton-code {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px;
  background: #172033;
}

.skeleton-code span {
  height: 9px;
  background: #344158;
}

.structured-empty {
  padding: 14px 12px;
  border-style: dashed;
  color: var(--muted);
  font-size: 12px;
}

@keyframes skeleton-pulse {
  50% {
    opacity: 0.5;
  }
}

/* 窄屏缩小表格字号和单元格内边距，保留横向滚动而不压缩列宽。 */
@media (max-width: 640px) {
  table {
    font-size: 12px;
  }

  th,
  td {
    padding: 6px 8px;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* 减少动态效果时关闭骨架脉冲动画。 */
  .skeleton-title,
  .skeleton-row span,
  .skeleton-code span {
    animation: none;
  }
}
</style>
