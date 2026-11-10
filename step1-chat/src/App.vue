<script setup lang="ts">
/**
 * 页面壳层只负责模式选择、输入和面板布局。
 * 所有聊天、流式、持久化和结构化状态都由 useChat 管理。
 */
import { computed, ref, watch } from "vue";
import { Bot, Eraser, RotateCcw, Send, Square } from "@lucide/vue";
import ChatMessageItem from "./components/ChatMessageItem.vue";
import ContextCompactionNotice from "./components/ContextCompactionNotice.vue";
import MemoryPanel from "./components/MemoryPanel.vue";
import PlanTimeline from "./components/PlanTimeline.vue";
import RagHitPanel from "./components/RagHitPanel.vue";
import ToolTracePanel from "./components/ToolTracePanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import { useChat } from "./composables/useChat";
import type { PlanMode, StructuredTarget } from "./types";

// 普通对话、资料问答和结构化模式各自使用不同 starter，避免误导用户。
const CHAT_STARTERS = [
  "现在几点",
  "广州的天气，顺便查查几点了",
  "什么是 Function Calling",
];
const RAG_STARTERS = [
  "不要把整篇文档塞进 prompt 冒充 RAG",
  "为什么改了切分还要重新入库",
  "今天北京适合出门吗？",
];
// 结构化 starter 与 target 一一对应，点击后仍走同一个 submit 入口。
const STRUCTURED_STARTERS: Record<StructuredTarget, string[]> = {
  table: [
    "生成一张三行模型对比表",
    "把三种部署方案整理成表格",
    "生成一份本周任务优先级表",
  ],
  code: [
    "生成一个 Vue 3 防抖组合函数",
    "写一个带重试的 TypeScript fetch 封装",
    "生成一个可访问的响应式导航栏示例",
  ],
};
// "text" 是本地 UI 值，不发送给后端；table/code 才会进入结构化端点。
const STRUCTURED_OPTIONS = [
  { value: "text", label: "普通输出" },
  { value: "table", label: "结构化表格" },
  { value: "code", label: "结构化代码" },
] as const;
// 计划链路的三种模式：auto 由服务端规则路由，另外两种强制指定。
const PLAN_MODE_OPTIONS = [
  { value: "auto", label: "计划：自动" },
  { value: "react", label: "计划：强制直答" },
  { value: "plan", label: "计划：强制规划" },
] as const;

// useChat 是唯一聊天状态源；App 只负责模式选择和页面接线。
const {
  messages,
  model,
  modelOptions,
  ragMode,
  searchKb,
  multiAgent,
  planEnabled,
  planMode,
  planState,
  reflectionEnabled,
  isStreaming,
  error,
  toolTrace,
  lastUsage,
  usageSummary,
  serverMode,
  contextCompaction,
  memoryUserId,
  allowMemory,
  memoryFacts,
  memoryLoading,
  memoryError,
  send,
  sendStructured,
  retry,
  stop,
  clear,
  changeModel,
  setRagMode,
  setSearchKb,
  setMultiAgent,
  setPlanEnabled,
  setPlanMode,
  refreshMemoryFacts,
  setAllowMemory,
  resetMemoryUserId,
  updateMemory,
  removeMemory,
  clearMemories,
  resolveToolConfirm,
} = useChat();
// 输入框和滚动容器是纯视图 ref，不进入 useChat 的持久化状态。
const input = ref("");
const chatRef = ref<HTMLElement | null>(null);
// 记忆管理浮层的开关；纯视图状态，面板本身的状态在 useChat 里。
const memoryOpen = ref(false);

/** 打开记忆面板时顺手刷新一次列表：可能刚刚在聊天里存了新记忆。 */
function openMemoryPanel() {
  memoryOpen.value = true;
  void refreshMemoryFacts();
}
// text 保持原有普通聊天；table/code 切换到独立结构化协议。
const structuredTarget = ref<StructuredTarget | "text">("text");

// 服务端模式只用于顶栏提示，不参与发送路由。
const modeLabel = computed(() =>
  serverMode.value === "api" ? "API" : serverMode.value === "mock" ? "Mock" : "连接中",
);

// starter 随 RAG/结构化/普通聊天模式切换。
const starters = computed(() => {
  if (ragMode.value) return RAG_STARTERS;
  if (structuredTarget.value === "table") return STRUCTURED_STARTERS.table;
  if (structuredTarget.value === "code") return STRUCTURED_STARTERS.code;
  return CHAT_STARTERS;
});
// RAG 优先于结构化；RAG 打开时隐藏结构化目标选择器。
const isStructuredMode = computed(
  () => !ragMode.value && structuredTarget.value !== "text",
);
// placeholder 只做交互提示，真实协议选择仍由 submit 决定。
const placeholder = computed(() => {
  if (ragMode.value) return "问已入库的笔记，Enter 发送";
  if (structuredTarget.value === "table") return "描述想要的表格，Enter 生成";
  if (structuredTarget.value === "code") return "描述想要的代码，Enter 生成";
  // 计划模式不用 prefetch 注入：知识库开着时由 Planner 安排检索步骤。
  if (searchKb.value && planEnabled.value) {
    return "计划模式：知识库已开启，Planner 会安排检索步骤";
  }
  if (searchKb.value && multiAgent.value) {
    return "多 Agent：将强制走 kb Worker 检索知识库";
  }
  if (searchKb.value) return "将先检索知识库并注入本轮（不再让模型调 searchDocs）";
  return "输入消息，Enter 发送";
});

// 顶栏标题必须反映实际端点，避免 UI 显示与请求路由不一致。
const chatEndpointTitle = computed(() =>
  isStructuredMode.value
    ? "当前：结构化输出（/api/chat/structured）"
    : planEnabled.value
      ? "当前：计划执行（/api/chat/plan）"
      : multiAgent.value
        ? "当前：普通对话（/api/chat/multi）"
        : "当前：普通对话（/api/chat）",
);
// 空状态标题与当前模式保持一致。
const emptyTitle = computed(() =>
  ragMode.value
    ? "根据笔记提问（资料问答）"
    : structuredTarget.value === "table"
      ? "生成一张结构化表格"
      : structuredTarget.value === "code"
        ? "生成一段结构化代码"
        : "开始你的第一段对话",
);

/**
 * 记忆注入目前只在单 Agent 普通对话链路（/api/chat）上接通了。
 * 其余链路（RAG / 结构化 / 计划 / Reflection / 多 Agent）本阶段没接，
 * 面板必须如实说明，否则会出现「记住了但没生效」的错觉。
 */
const memoryInjectionSupported = computed(
  () =>
    !ragMode.value &&
    !isStructuredMode.value &&
    !planEnabled.value &&
    !reflectionEnabled.value &&
    !multiAgent.value,
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

// 当前 citation 编号只影响命中面板高亮，不改变消息正文。
const highlightIndex = computed(() => citeFocus.value?.n ?? null);

/** 右侧栏有内容才展开，避免空栏挤占对话区 */
const hasSideContent = computed(() => {
  if (ragMode.value && panelRag.value) return true;
  // 计划运行时状态存在就展示时间线，即使当前判定走的是 ReAct。
  if (!ragMode.value && planState.value) return true;
  if (!ragMode.value && toolTrace.value.length > 0) return true;
  if (serverMode.value === "api" && (lastUsage.value || usageSummary.value)) return true;
  return false;
});

/** 记录 citation 所属消息和编号，避免不同回答的 [1] 互相串面板。 */
function handleCite(messageId: string, n: number) {
  citeFocus.value = { messageId, n };
}

// 切换 RAG 模式时清除旧的 citation 焦点。
watch(ragMode, () => {
  citeFocus.value = null;
});

// 消息增长或流式快照更新时保持滚动到底部。
watch(messages, () => {
  chatRef.value?.scrollTo({ top: chatRef.value.scrollHeight, behavior: "smooth" });
});

/** 统一发送入口：校验输入后按 RAG/结构化/普通聊天选择对应链路。 */
async function submit(content?: string) {
  const text = (content ?? input.value).trim();
  if (!text || isStreaming.value) return;
  input.value = "";
  // RAG 模式下结构化选择器不可见；其余 table/code 走独立发送入口。
  if (!ragMode.value && structuredTarget.value !== "text") {
    await sendStructured(text, structuredTarget.value);
    return;
  }
  await send(text);
}

function handleKeydown(event: KeyboardEvent) {
  // 输入法组合中的 Enter 不发送，Shift+Enter 保留换行。
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void submit();
  }
}

/** 模型 select 的 DOM value 直接交给 useChat 持久化。 */
function handleModelChange(event: Event) {
  changeModel((event.target as HTMLSelectElement).value);
}

// select 的 value 是字符串，这里收窄回前端允许的三种输出模式。
function handleStructuredChange(event: Event) {
  structuredTarget.value = (event.target as HTMLSelectElement).value as
    | StructuredTarget
    | "text";
}

// 计划模式选择器同理，value 必须收窄回 PlanMode。
function handlePlanModeChange(event: Event) {
  setPlanMode((event.target as HTMLSelectElement).value as PlanMode);
}

// 三个 toggle 只翻转 useChat 中的持久化开关，不在这里直接发请求。
function toggleRagMode() {
  setRagMode(!ragMode.value);
}

function toggleSearchKb() {
  setSearchKb(!searchKb.value);
}

function toggleMultiAgent() {
  setMultiAgent(!multiAgent.value);
}

// 计划开关只切换端点，不直接发请求。
function togglePlanEnabled() {
  setPlanEnabled(!planEnabled.value);
}
</script>

<template>
  <div class="app">
    <!-- 顶栏：服务端模式、对话模式、模型和输出目标统一放在同一操作区。 -->
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
          :title="ragMode ? '当前：资料问答（/api/rag/chat）' : chatEndpointTitle"
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
          <option v-for="option in modelOptions" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
        <select
          v-if="!ragMode"
          class="model-select"
          :value="structuredTarget"
          :disabled="isStreaming"
          title="选择输出方式"
          aria-label="选择输出方式"
          @change="handleStructuredChange"
        >
          <option
            v-for="option in STRUCTURED_OPTIONS"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <!-- 记忆管理入口：顶栏常驻，随时能看到「记忆开没开」。 -->
        <button
          class="mode-toggle memory-toggle"
          :class="{ on: allowMemory }"
          :title="allowMemory ? '长期记忆已开启，点击管理' : '长期记忆已关闭，点击管理'"
          @click="openMemoryPanel"
        >
          记忆{{ allowMemory ? "开" : "关" }}
        </button>
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

    <!-- 主工作区：左侧对话，右侧按需显示检索、trace 和 usage 面板。 -->
    <div class="workspace">
      <div class="chat-column">
        <main ref="chatRef" class="chat">
          <!-- 空状态使用当前模式的标题和 starter。 -->
          <div v-if="messages.length === 0" class="empty" data-state="empty">
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
            <!-- 只有最后一条消息可以显示停止光标或结构化重试按钮。 -->
            <ChatMessageItem
              v-for="(message, index) in messages"
              :key="message.id"
              :message="message"
              :streaming="isStreaming && index === messages.length - 1"
              :can-retry="index === messages.length - 1"
              :active-cite="citeFocus?.messageId === message.id ? citeFocus.n : null"
              @cite="handleCite(message.id, $event)"
              @retry="retry"
            />
          </template>
        </main>

        <!-- 顶层错误只显示当前请求的简短可读文案。 -->
        <div v-if="error" class="error-banner" role="alert">{{ error }}</div>

        <!-- 上下文压缩提示：本轮没有发生压缩时不渲染，避免噪音。 -->
        <ContextCompactionNotice :event="contextCompaction" />

        <!-- 输入区：流式中显示停止按钮，否则显示发送按钮。 -->
        <footer class="composer">
          <div class="composer-row">
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
          </div>
          <div v-if="!ragMode" class="composer-opts">
            <label class="kb-opt">
              <input
                type="checkbox"
                :checked="multiAgent"
                :disabled="isStreaming"
                @change="toggleMultiAgent"
              />
              多 Agent
            </label>
            <label class="kb-opt">
              <input
                type="checkbox"
                :checked="searchKb"
                :disabled="isStreaming"
                @change="toggleSearchKb"
              />
              搜索知识库
              <span class="kb-hint" title="服务端必检索并注入；聊天 ReAct 只保留天气/时间等工具">（必检索）</span>
            </label>
            <!-- 计划开关：命中后普通对话改走 /api/chat/plan。 -->
            <label class="kb-opt">
              <input
                type="checkbox"
                :checked="planEnabled"
                :disabled="isStreaming || isStructuredMode"
                @change="togglePlanEnabled"
              />
              计划模式
            </label>
            <select
              v-if="planEnabled"
              class="model-select plan-mode-select"
              :value="planMode"
              :disabled="isStreaming || isStructuredMode"
              title="选择计划路由方式"
              aria-label="选择计划路由方式"
              @change="handlePlanModeChange"
            >
              <option
                v-for="option in PLAN_MODE_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </div>
        </footer>
      </div>

      <!-- 侧栏只在确实有内容时出现，避免空面板挤压对话宽度。 -->
      <aside v-if="hasSideContent" class="side-rail" aria-label="过程与用量">
        <RagHitPanel v-if="ragMode" :rag="panelRag" :highlight-index="highlightIndex" />
        <!-- 计划时间线独立成区，工具过程仍只进 ToolTracePanel。 -->
        <PlanTimeline
          v-if="!ragMode"
          :state="planState"
          :requested-mode="planMode"
        />
        <ToolTracePanel
          v-if="!ragMode"
          :steps="toolTrace"
          :confirm-enabled="isStreaming"
          :memory-enabled="allowMemory"
          @confirm="resolveToolConfirm"
        />
        <UsagePanel
          :last-usage="lastUsage"
          :summary="usageSummary"
          :server-mode="serverMode"
          :compaction="contextCompaction"
        />
      </aside>
    </div>

    <!-- 记忆管理浮层：点遮罩关闭，内容超出时面板内部滚动。 -->
    <div v-if="memoryOpen" class="memory-overlay" @click.self="memoryOpen = false">
      <div class="memory-dialog" role="dialog" aria-label="记忆管理">
        <header class="dialog-head">
          <strong>记忆管理</strong>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭记忆管理"
            @click="memoryOpen = false"
          >
            ×
          </button>
        </header>
        <MemoryPanel
          :facts="memoryFacts"
          :allow-memory="allowMemory"
          :user-id="memoryUserId"
          :loading="memoryLoading"
          :error="memoryError"
          :injection-supported="memoryInjectionSupported"
          @update:allow-memory="setAllowMemory"
          @update-fact="(payload) => updateMemory(payload.id, payload.patch)"
          @delete-fact="(id) => removeMemory(id)"
          @clear-all="clearMemories"
          @reset-identity="resetMemoryUserId"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 计划模式选择器放在输入区，保持紧凑，避免抢走顶栏模型选择器的空间。 */
.plan-mode-select {
  flex: none;
  height: 26px;
  font-size: 12px;
  color: var(--muted);
}
/* 记忆入口紧跟模式按钮，用状态色区分「开着」还是「关着」。 */
.memory-toggle.on {
  color: #065f46;
  background: #d1fae5;
  border-color: #6ee7b7;
}
.memory-toggle:not(.on) {
  color: var(--muted);
}
.memory-overlay {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(15, 23, 42, 0.35);
}
.memory-dialog {
  width: min(560px, 100%);
  max-height: min(82vh, 720px);
  overflow-y: auto;
  padding: 14px 16px 16px;
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.22);
}
.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
</style>
