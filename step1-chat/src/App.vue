<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Bot, Eraser, RotateCcw, Send, Square } from "@lucide/vue";
import ChatMessageItem from "./components/ChatMessageItem.vue";
import RagHitPanel from "./components/RagHitPanel.vue";
import ToolTracePanel from "./components/ToolTracePanel.vue";
import { useChat } from "./composables/useChat";
import { MODEL_OPTIONS } from "./types";

const CHAT_STARTERS = ["北京今天适合出门吗？", "介绍一下流式输出", "什么是 Function Calling"];
const RAG_STARTERS = [
  "不要把整篇文档塞进 prompt 冒充 RAG",
  "为什么改了切分还要重新入库",
  "今天北京适合出门吗？",
];

const {
  messages,
  model,
  ragMode,
  isStreaming,
  error,
  toolTrace,
  serverMode,
  send,
  retry,
  stop,
  clear,
  changeModel,
  setRagMode,
} = useChat();
const input = ref("");
const chatRef = ref<HTMLElement | null>(null);

const modeLabel = computed(() =>
  serverMode.value === "api" ? "API" : serverMode.value === "mock" ? "Mock" : "连接中",
);

const starters = computed(() => (ragMode.value ? RAG_STARTERS : CHAT_STARTERS));
const placeholder = computed(() =>
  ragMode.value ? "问已入库的笔记，Enter 发送" : "输入消息，Enter 发送",
);
const emptyTitle = computed(() =>
  ragMode.value ? "根据笔记提问（资料问答）" : "开始你的第一段对话",
);

/** 最近一次资料问答的命中（挂在助手消息上），给面板用。 */
const latestRag = computed(() => {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index];
    if (message?.role === "assistant" && message.rag) return message.rag;
  }
  return null;
});

const citeFocus = ref<{ messageId: string; n: number } | null>(null);

/** 点引用时对准那条回答的命中；否则仍显示最近一次资料问答。 */
const panelRag = computed(() => {
  if (citeFocus.value) {
    const focused = messages.value.find((message) => message.id === citeFocus.value?.messageId);
    if (focused?.rag) return focused.rag;
  }
  return latestRag.value;
});

const highlightIndex = computed(() => citeFocus.value?.n ?? null);

function handleCite(messageId: string, n: number) {
  citeFocus.value = { messageId, n };
}

watch(ragMode, () => {
  citeFocus.value = null;
});

watch(messages, () => {
  chatRef.value?.scrollTo({ top: chatRef.value.scrollHeight, behavior: "smooth" });
});

async function submit(content?: string) {
  const text = (content ?? input.value).trim();
  if (!text || isStreaming.value) return;
  input.value = "";
  await send(text);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

function handleModelChange(event: Event) {
  changeModel((event.target as HTMLSelectElement).value);
}

function toggleRagMode() {
  setRagMode(!ragMode.value);
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"><Bot :size="18" /></span>
        <span>Step 1 · AI Chat</span>
      </div>
      <div class="topbar-actions">
        <span class="mode-badge" :class="serverMode">{{ modeLabel }}</span>
        <button
          class="mode-toggle"
          :class="{ on: ragMode }"
          :disabled="isStreaming"
          :title="ragMode ? '当前：资料问答（/api/rag/chat）' : '当前：普通对话（/api/chat）'"
          :aria-pressed="ragMode"
          @click="toggleRagMode"
        >
          {{ ragMode ? "资料问答" : "普通对话" }}
        </button>
        <select
          class="model-select"
          :value="model"
          :disabled="isStreaming"
          aria-label="选择模型"
          @change="handleModelChange"
        >
          <option v-for="option in MODEL_OPTIONS" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
        <button
          class="icon-button"
          :disabled="isStreaming || messages.length === 0"
          title="重新生成"
          aria-label="重新生成"
          @click="retry"
        >
          <RotateCcw :size="16" />
        </button>
        <button
          class="icon-button"
          :disabled="messages.length === 0"
          title="清空会话"
          aria-label="清空会话"
          @click="clear"
        >
          <Eraser :size="16" />
        </button>
      </div>
    </header>

    <main ref="chatRef" class="chat">
      <div v-if="messages.length === 0" class="empty">
        <div class="empty-mark"><Bot :size="28" /></div>
        <p class="empty-title">{{ emptyTitle }}</p>
        <div class="starters">
          <button
            v-for="starter in starters"
            :key="starter"
            class="starter"
            :disabled="isStreaming"
            @click="submit(starter)"
          >
            {{ starter }}
          </button>
        </div>
      </div>
      <template v-else>
        <ChatMessageItem
          v-for="(message, index) in messages"
          :key="message.id"
          :message="message"
          :streaming="isStreaming && index === messages.length - 1"
          :active-cite="citeFocus?.messageId === message.id ? citeFocus.n : null"
          @cite="handleCite(message.id, $event)"
        />
      </template>
    </main>

    <RagHitPanel v-if="ragMode" :rag="panelRag" :highlight-index="highlightIndex" />
    <ToolTracePanel v-if="!ragMode" :steps="toolTrace" />

    <div v-if="error" class="error-banner" role="alert">{{ error }}</div>

    <footer class="composer">
      <textarea
        v-model="input"
        class="composer-input"
        :disabled="isStreaming"
        :placeholder="placeholder"
        rows="1"
        @keydown="handleKeydown"
      />
      <button
        v-if="isStreaming"
        class="send-button stop"
        title="停止"
        aria-label="停止"
        @click="stop"
      >
        <Square :size="16" />
      </button>
      <button
        v-else
        class="send-button"
        :disabled="!input.trim()"
        title="发送"
        aria-label="发送"
        @click="submit()"
      >
        <Send :size="16" />
      </button>
    </footer>
  </div>
</template>
