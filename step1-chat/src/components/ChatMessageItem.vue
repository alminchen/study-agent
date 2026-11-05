<script setup lang="ts">
/**
 * 单条消息渲染器。
 *
 * 普通文本、RAG citation 和结构化 block 共用同一个消息容器；结构化状态只影响
 * 当前气泡内部的展示和重试入口，不改变 useChat 的请求生命周期。
 */
import { computed } from "vue";
import { Bot, RotateCcw } from "@lucide/vue";
import { findHitByPromptIndex, splitCitedText, validPromptIndexes } from "../rag/citations";
import StructuredBlock from "./StructuredBlock.vue";
import type { ChatMessage, StructuredErrorCode } from "../types";

const props = defineProps<{
  /** 当前消息；普通文本、RAG citations 和结构化状态共用这一容器。 */
  message: ChatMessage;
  /** 是否仍处于全局流式请求中。 */
  streaming: boolean;
  /** 只有最后一条消息允许显示结构化重试入口。 */
  canRetry: boolean;
  /** 当前点中的引用编号；只高亮本条消息 */
  activeCite?: number | null;
}>();

const emit = defineEmits<{
  /** 点击有效 citation 时通知父组件定位命中面板。 */
  cite: [n: number];
  /** 结构化失败时请求父组件重新运行同一 target。 */
  retry: [];
}>();

// 错误码到用户文案的映射放在组件层，useChat 只保留机器可判定的状态。
const STRUCTURED_ERROR_REASONS: Record<StructuredErrorCode, string> = {
  model_request_failed: "模型请求失败",
  model_stream_interrupted: "连接中断，结果未完成",
  partial_parse_failed: "增量内容解析失败",
  invalid_final_json: "模型返回的内容不是合法 JSON",
  schema_validation_failed: "结果不符合表格或代码格式",
  provider_json_mode_unsupported: "当前模型不支持 JSON mode",
};

// citation 只对本次 RAG 注入的 hits 生效，无效编号保留但禁用。
const validIndexes = computed(() => validPromptIndexes(props.message.rag?.hits));

// 普通消息直接展示文本；RAG assistant 消息再拆成文本和 citation chip。
const parts = computed(() => {
  if (!props.message.rag || props.message.role !== "assistant") {
    return [{ kind: "text" as const, text: props.message.content }];
  }
  return splitCitedText(props.message.content, validIndexes.value);
});

// RAG 底注只展示检索结果摘要，不重复正文内容。
const ragCaption = computed(() => {
  const rag = props.message.rag;
  if (!rag) return "";
  const score = rag.topScore == null ? "—" : rag.topScore.toFixed(2);
  if (rag.empty) return `资料里没有 · Top1 ${score} · 未调模型`;
  return rag.calledModel ? `已根据资料回答 · Top1 ${score}` : `资料问答 · Top1 ${score}`;
});

// structuredStatus 负责把内部状态机转换成面向用户的短状态文案。
const structuredStatus = computed(() => {
  const state = props.message.structured;
  if (!state) return "";
  const objectName = state.target === "table" ? "表格" : "代码";
  if (state.status === "streaming") return `正在生成${objectName}`;
  if (state.status === "completed") return `${objectName}已生成`;
  if (state.status === "incomplete") {
    return `${objectName}未完成，已保留最后一次完整内容`;
  }
  return state.errorCode
    ? STRUCTURED_ERROR_REASONS[state.errorCode]
    : "生成失败，请重试";
});

// tone 决定状态点颜色；streaming 是默认态，因此无需显式分支。
const structuredStatusTone = computed(() => {
  const status = props.message.structured?.status;
  if (status === "error") return "error";
  if (status === "incomplete") return "incomplete";
  if (status === "completed") return "completed";
  return "streaming";
});

// data-state 将 loading/partial/done/incomplete/error 暴露给 CSS 和测试选择器。
const structuredVisualState = computed(() => {
  const state = props.message.structured;
  if (!state) return null;
  if (state.status === "streaming") {
    return state.snapshot || state.result ? "partial" : "loading";
  }
  return state.status === "completed" ? "done" : state.status;
});

/** 生成 citation 的 title；无效编号明确说明不能作为依据。 */
function citeTitle(n: number, valid: boolean): string {
  if (!valid) return `[${n}] 不在本次注入的资料里，不能当依据`;
  const hit = findHitByPromptIndex(props.message.rag?.hits, n);
  const label = hit?.title || hit?.id || `资料 ${n}`;
  return `查看 [${n}] ${label}`;
}

/** 只允许点击本次有效 citation，避免 UI 发出无法定位的编号。 */
function onCite(n: number, valid: boolean) {
  if (!valid) return;
  emit("cite", n);
}
</script>

<template>
  <div class="message" :class="message.role">
    <div class="avatar">
      <span v-if="message.role === 'user'">我</span>
      <Bot v-else :size="16" />
    </div>
    <div class="bubble">
      <!-- 结构化消息完全由 snapshot/result 驱动，不再走文本拼接分支。 -->
      <div
        v-if="message.structured"
        class="structured-message"
        :data-state="structuredVisualState"
        :aria-busy="message.structured.status === 'streaming'"
      >
        <StructuredBlock
          :snapshot="message.structured.snapshot"
          :result="message.structured.result"
          :status="message.structured.status"
          :target="message.structured.target"
        />
        <div class="structured-footer">
          <!-- role=alert 只用于真正 error；生成中和未完成状态保持 polite。 -->
          <div
            class="structured-status"
            :class="structuredStatusTone"
            :role="message.structured.status === 'error' ? 'alert' : 'status'"
            aria-live="polite"
          >
            <span class="status-dot" aria-hidden="true" />
            <span>{{ structuredStatus }}</span>
          </div>
          <!-- 重试按钮只出现在最后一条失败消息，避免历史消息重复触发请求。 -->
          <button
            v-if="message.structured.status === 'error' && canRetry"
            type="button"
            class="structured-retry"
            :disabled="streaming"
            title="重新生成"
            aria-label="重新生成结构化结果"
            @click="emit('retry')"
          >
            <RotateCcw :size="14" />
            重试
          </button>
        </div>
      </div>
      <!-- 普通消息和 RAG 文本仍使用原有文本/citation 渲染。 -->
      <div v-else class="bubble-text">
        <template v-for="(part, index) in parts" :key="index">
          <template v-if="part.kind === 'text'">{{ part.text }}</template>
          <button
            v-else
            type="button"
            class="cite-chip"
            :class="{ on: part.valid && activeCite === part.n, invalid: !part.valid }"
            :disabled="!part.valid"
            :title="citeTitle(part.n, part.valid)"
            @click="onCite(part.n, part.valid)"
          >[{{ part.n }}]</button>
        </template>
        <span v-if="streaming" class="caret" />
      </div>
      <div v-if="ragCaption" class="bubble-meta">{{ ragCaption }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 结构化消息占满气泡内容宽度，并允许内部表格自行横向滚动。 */
.structured-message {
  width: 100%;
  min-width: 0;
}

/* 状态与重试按钮允许换行，窄屏下不会挤出气泡。 */
.structured-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  margin-top: 8px;
}

.structured-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

/* 状态点使用 currentColor，文案和点会随状态色同步变化。 */
.status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.structured-status.streaming .status-dot {
  animation: status-pulse 1s ease-in-out infinite;
}

/* 四种终态使用不同颜色；streaming 继续使用默认 muted 色。 */
.structured-status.completed {
  color: #047857;
}

.structured-status.incomplete {
  color: #b45309;
}

.structured-status.error {
  color: var(--danger);
}

/* 重试按钮保持固定可点击尺寸，并在禁用时给出明确反馈。 */
.structured-retry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 28px;
  padding: 0 9px;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  background: #ffffff;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}

.structured-retry:hover:not(:disabled) {
  background: var(--danger-soft);
}

.structured-retry:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@keyframes status-pulse {
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* 用户要求减少动态效果时停止状态点脉冲。 */
  .structured-status.streaming .status-dot {
    animation: none;
  }
}
</style>
