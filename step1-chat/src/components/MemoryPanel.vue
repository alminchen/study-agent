<script setup lang="ts">
/**
 * 长期记忆管理面板。
 *
 * 隐私要求是「用户能看到并删除」，所以这个面板是记忆功能的一部分，
 * 不是可选装饰：
 *   - 开关：关掉之后既不注入也不抽取，聊天照常
 *   - 列表：看到模型到底记住了什么（key / value / 来源 / 置信度）
 *   - 冲突：同 key 出现两个值时不自动覆盖，交在这里裁决
 *   - 删除 / 清空：随时可以撤掉
 *
 * 面板只负责展示和收集意图，真正的请求都在 useChat 里。
 */
import { computed, ref } from "vue";
import type { MemoryFact, MemorySource } from "../types";

const props = withDefaults(
  defineProps<{
    /** 当前匿名用户的记忆列表。 */
    facts: MemoryFact[];
    /** 是否允许长期记忆。 */
    allowMemory: boolean;
    /** 当前匿名用户 id。 */
    userId: string;
    /** 列表是否正在加载。 */
    loading?: boolean;
    /** 记忆操作的错误文案。 */
    error?: string | null;
    /**
     * 当前聊天链路的人话说明，例如「资料问答（/api/rag/chat）」。
     * 面板要如实说明「记忆在当前这条链路上到底起不生效」。
     */
    chainLabel?: string;
  }>(),
  {
    loading: false,
    error: null,
    chainLabel: "普通对话（/api/chat）",
  },
);

const emit = defineEmits<{
  "update:allowMemory": [next: boolean];
  "update-fact": [payload: { id: string; patch: { value?: string; confidence?: number } }];
  "delete-fact": [id: string];
  "clear-all": [];
  "reset-identity": [];
}>();

/** 来源分类的中文说明；与服务端 MemorySource 逐值对应。 */
const SOURCE_TEXT: Record<MemorySource, string> = {
  user_explicit_preference: "用户明确偏好",
  user_correction: "用户纠正",
  project_fact: "项目事实",
  tool_learned_fact: "工具学到的",
};

/** 正在编辑的那条记忆 id；同一时刻只编辑一条。 */
const editingId = ref<string | null>(null);
const editValue = ref("");
const editConfidence = ref(0.8);
/** 清空是不可撤销的：先点一次进入确认态，再点一次才真的清。 */
const confirmingClear = ref(false);
/** 刚复制完的 id，短暂高亮一下给用户反馈。 */
const copiedId = ref<string | null>(null);

const hasFacts = computed(() => props.facts.length > 0);
const conflictCount = computed(() => props.facts.filter((fact) => fact.conflict).length);

function sourceText(source: MemorySource): string {
  return SOURCE_TEXT[source] ?? source;
}

/** 短 id：只留尾部 6 位，够认出一条，不用把整串摊在界面上。 */
function shortId(id: string): string {
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "-";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 置信度按百分比展示；小数点保留一位。 */
function confidenceText(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function startEdit(fact: MemoryFact) {
  editingId.value = fact.id;
  editValue.value = fact.value;
  editConfidence.value = fact.confidence;
}

function cancelEdit() {
  editingId.value = null;
}

function saveEdit(fact: MemoryFact) {
  const value = editValue.value.trim();
  if (!value) return;
  emit("update-fact", {
    id: fact.id,
    patch: { value, confidence: Number(editConfidence.value.toFixed(2)) },
  });
  editingId.value = null;
}

/** 裁决一：保留当前值。提交当前 value 即视为用户拍板。 */
function keepCurrent(fact: MemoryFact) {
  emit("update-fact", { id: fact.id, patch: { value: fact.value } });
}

/** 裁决二：采用冲突里的那个值。 */
function useConflicting(fact: MemoryFact) {
  const incoming = fact.conflictingValue;
  if (!incoming) return;
  emit("update-fact", { id: fact.id, patch: { value: incoming } });
}

/**
 * 裁决三：两个值都留。
 *
 * 合并结果是一个可以直接编辑的草稿（"旧值 / 新值"），
 * 用户随后还能在编辑框里改成更准确的说法。
 */
function mergeBoth(fact: MemoryFact) {
  const incoming = fact.conflictingValue;
  if (!incoming) return;
  emit("update-fact", { id: fact.id, patch: { value: `${fact.value} / ${incoming}` } });
}

function requestClear() {
  if (!confirmingClear.value) {
    confirmingClear.value = true;
    return;
  }
  confirmingClear.value = false;
  emit("clear-all");
}

/** 复制记忆 id：剪贴板不可用时静默失败，不弹错误打断操作。 */
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    copiedId.value = id;
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = null;
    }, 1500);
  } catch {
    copiedId.value = null;
  }
}
</script>

<template>
  <section class="memory-panel" aria-label="长期记忆管理">
    <header class="panel-head">
      <div class="head-text">
        <h3>长期记忆</h3>
        <p class="head-sub">
          跨会话保留的偏好与项目事实，只存在本机（{{ userId }}）
        </p>
      </div>
      <label class="switch">
        <input
          type="checkbox"
          :checked="allowMemory"
          @change="emit('update:allowMemory', !allowMemory)"
        />
        <span>{{ allowMemory ? "已开启" : "已关闭" }}</span>
      </label>
    </header>

    <!-- 关闭状态要如实说明：不能让人以为「记住了但没生效」。 -->
    <p v-if="!allowMemory" class="notice off">
      长期记忆已关闭：不会向模型注入记忆，也不会抽取新的偏好。
    </p>
    <p v-else class="notice on">
      当前链路（{{ chainLabel }}）已接入长期记忆：
      命中的记忆会注入本轮上下文，对话里的明确偏好会在这一轮结束后被记住。
    </p>

    <p v-if="error" class="notice error" role="alert">{{ error }}</p>

    <div class="toolbar">
      <span class="count">
        共 {{ facts.length }} 条<template v-if="conflictCount">，{{ conflictCount }} 条待裁决</template>
      </span>
      <button type="button" class="ghost-btn" @click="emit('reset-identity')">
        换一套匿名身份
      </button>
      <button
        type="button"
        class="ghost-btn danger"
        :class="{ armed: confirmingClear }"
        @click="requestClear"
      >
        {{ confirmingClear ? "确认清空？" : "清空所有记忆" }}
      </button>
    </div>

    <!-- 空状态要说清记忆是「聊出来的」，不是需要用户手动维护的清单。 -->
    <p v-if="!hasFacts && !loading" class="empty">
      暂无长期记忆，聊天中表达明确偏好（例如「以后都用中文」）会自动记住。
    </p>
    <p v-else-if="!hasFacts && loading" class="empty">正在读取记忆…</p>

    <ul v-else class="fact-list">
      <li
        v-for="fact in facts"
        :key="fact.id"
        class="fact-item"
        :class="{ conflict: fact.conflict }"
      >
        <div class="fact-main">
          <div class="fact-head">
            <code class="fact-key">{{ fact.key }}</code>
            <span class="tag">{{ sourceText(fact.source) }}</span>
            <span v-if="fact.conflict" class="tag conflict-tag">值冲突</span>
          </div>

          <template v-if="editingId === fact.id">
            <input v-model="editValue" class="edit-input" aria-label="记忆内容" />
            <label class="edit-confidence">
              置信度 {{ confidenceText(editConfidence) }}
              <input
                v-model.number="editConfidence"
                type="range"
                min="0.6"
                max="1"
                step="0.05"
                aria-label="置信度"
              />
            </label>
            <div class="edit-actions">
              <button type="button" class="mini-btn primary" @click="saveEdit(fact)">保存</button>
              <button type="button" class="mini-btn" @click="cancelEdit">取消</button>
            </div>
          </template>
          <template v-else>
            <p class="fact-value">{{ fact.value }}</p>
          </template>

          <div class="fact-meta">
            <span class="confidence">
              <span class="bar"><span class="fill" :style="{ width: confidenceText(fact.confidence) }" /></span>
              {{ confidenceText(fact.confidence) }}
            </span>
            <span>{{ formatTime(fact.updatedAt) }}</span>
            <code class="fact-id">{{ shortId(fact.id) }}</code>
          </div>

          <!-- 冲突裁决：三个按钮都是「显式提交一个 value」，服务端据此清掉冲突标记。 -->
          <div v-if="fact.conflict" class="conflict-box">
            <p class="conflict-line">
              另一个值：<strong>{{ fact.conflictingValue }}</strong>
            </p>
            <div class="conflict-actions">
              <button type="button" class="mini-btn" @click="keepCurrent(fact)">保留当前</button>
              <button type="button" class="mini-btn" @click="useConflicting(fact)">用新值</button>
              <button type="button" class="mini-btn" @click="mergeBoth(fact)">合并</button>
            </div>
          </div>

          <div v-if="editingId !== fact.id" class="row-actions">
            <button type="button" class="mini-btn" @click="startEdit(fact)">编辑</button>
            <button type="button" class="mini-btn danger" @click="emit('delete-fact', fact.id)">
              删除
            </button>
            <button type="button" class="mini-btn" @click="copyId(fact.id)">
              {{ copiedId === fact.id ? "已复制" : "复制 ID" }}
            </button>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.memory-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.head-text {
  min-width: 0;
}
.head-text h3 {
  margin: 0;
  font-size: 0.95rem;
}
.head-sub {
  margin: 0.2rem 0 0;
  font-size: 0.75rem;
  color: var(--muted);
  word-break: break-all;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  flex: none;
  font-size: 0.78rem;
  color: var(--muted);
}
.notice {
  margin: 0;
  padding: 0.5rem 0.65rem;
  border-radius: var(--radius);
  font-size: 0.78rem;
  line-height: 1.6;
}
.notice.off {
  background: #f3f4f6;
  color: var(--muted);
}
.notice.on {
  background: #ecfdf5;
  color: #065f46;
}
.notice.warn {
  background: #fef3c7;
  color: #92400e;
}
.notice.error {
  background: var(--danger-soft);
  color: var(--danger);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.count {
  font-size: 0.76rem;
  color: var(--muted);
  margin-right: auto;
}
.ghost-btn {
  font-size: 0.76rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: #fff;
  color: var(--text);
  cursor: pointer;
}
.ghost-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.ghost-btn.danger {
  color: var(--danger);
}
.ghost-btn.danger.armed {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.empty {
  margin: 0;
  padding: 0.9rem 0.75rem;
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--muted);
}
.fact-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.fact-item {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 0.6rem 0.7rem;
  background: #fff;
}
.fact-item.conflict {
  border-color: #fcd34d;
  background: #fffbeb;
}
.fact-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.fact-key {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--accent);
}
.tag {
  font-size: 0.7rem;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: var(--accent-soft);
  color: #065f46;
}
.tag.conflict-tag {
  background: #fde68a;
  color: #92400e;
}
.fact-value {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  line-height: 1.6;
  word-break: break-word;
}
.fact-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-top: 0.35rem;
  font-size: 0.72rem;
  color: var(--muted);
}
.confidence {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.bar {
  display: inline-block;
  width: 52px;
  height: 6px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.fill {
  display: block;
  height: 100%;
  background: var(--accent);
}
.fact-id {
  color: var(--muted);
}
.row-actions,
.conflict-actions,
.edit-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
  margin-top: 0.45rem;
}
.mini-btn {
  font-size: 0.74rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  cursor: pointer;
}
.mini-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.mini-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.mini-btn.danger {
  color: var(--danger);
}
.conflict-box {
  margin-top: 0.45rem;
  padding: 0.45rem 0.5rem;
  border-radius: 6px;
  background: #fef3c7;
}
.conflict-line {
  margin: 0;
  font-size: 0.78rem;
  color: #92400e;
  word-break: break-word;
}
.edit-input {
  width: 100%;
  margin-top: 0.4rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--line);
  border-radius: 6px;
  font-size: 0.82rem;
  outline: none;
}
.edit-input:focus {
  border-color: var(--accent);
}
.edit-confidence {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.35rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.edit-confidence input {
  flex: 1;
  min-width: 0;
}
</style>
