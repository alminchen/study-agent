<script setup lang="ts">
// ============================================================
// 知识库面板：分类 / 上传 / 任务列表 / 块预览 / 分类内提问
// ============================================================
// 干什么：把 /api/kb/* 的能力接到一个屏上，形成「选类 -> 上传 -> 看状态 ->
//   预览块 -> 提问 -> 删除」的完整闭环（步骤 8 交付页）。
// 为什么独立成组件：聊天主链路不依赖它，隔离状态与轮询，避免污染 useChat。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
// 全部 kb 接口与类型都从这里来，组件不直接写 fetch
import {
  createKbCategory,
  deleteKbDoc,
  listKbCategories,
  listKbChunks,
  listKbTasks,
  retryKbTask,
  searchKbCategory,
  uploadKbFile,
  type KbAskHit,
  type KbCategory,
  type KbChunk,
  type KbTaskWithChunks,
} from "../api/kb";

// ---------------- 分类状态 ----------------
// 分类列表：下拉框和标签的数据源
const categories = ref<KbCategory[]>([]);
// 当前选中的分类名：上传与提问都用它作为硬边界
const selectedCategory = ref("");
// 新建分类的输入框内容
const newCategoryName = ref("");

// ---------------- 上传状态 ----------------
// 隐藏的文件选择框；只通过上传按钮触发
const fileInputRef = ref<HTMLInputElement | null>(null);
// 上传进行中标记：避免重复点击重复提交
const uploading = ref(false);
// 上传后的提示文案（成功 / 失败都写这里）
const uploadMessage = ref("");

// ---------------- 任务列表状态 ----------------
// 任务列表：轮询刷新，展示每条任务的状态与块数
const tasks = ref<KbTaskWithChunks[]>([]);
// 列表加载失败时的提示
const tasksError = ref("");
// 轮询定时器句柄：卸载时清理，防止内存泄漏
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ---------------- 块预览状态 ----------------
// 预览目标 docId：null 表示面板未展开
const previewDocId = ref<string | null>(null);
// 预览的块列表
const previewChunks = ref<KbChunk[]>([]);
// 预览加载中标记
const previewLoading = ref(false);

// ---------------- 提问状态 ----------------
// 问题输入框内容
const question = ref("");
// 提问命中结果
const hits = ref<KbAskHit[]>([]);
// 提问进行中标记
const searching = ref(false);
// 提问失败提示
const searchError = ref("");

// 状态中文标签：列表直接展示，避免用户看英文枚举
const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  chunking: "切片中",
  chunked: "已切块",
  embedding: "入库中",
  searchable: "可检索",
  failed: "失败",
};

// 顶部提示：没有分类时引导先建类，避免上传被服务端拒绝
const categoryHint = computed(() =>
  categories.value.length === 0 ? "还没有分类，先新建一个分类再上传" : "",
);

/** 拉取分类列表；首次进入面板时调用。 */
async function refreshCategories() {
  try {
    // 请求分类接口并写入响应式数组
    const data = await listKbCategories();
    categories.value = data.categories;
    // 若当前选中类已被删除，自动回落到第一个类，避免悬空选择
    if (!categories.value.some((c) => c.name === selectedCategory.value)) {
      selectedCategory.value = categories.value[0]?.name ?? "";
    }
  } catch (error) {
    // 分类失败不阻塞主流程，写提示即可
    uploadMessage.value = error instanceof Error ? error.message : "加载分类失败";
  }
}

/** 新建分类；成功后自动选中，方便紧接着上传。 */
async function handleCreateCategory() {
  // 空名字直接忽略，减少一次无意义请求
  const name = newCategoryName.value.trim();
  if (!name) return;
  try {
    // 调建类接口（同名去重由服务端保证）
    const data = await createKbCategory(name);
    newCategoryName.value = "";
    selectedCategory.value = data.category.name;
    // 重新拉列表，保持下拉框与服务端一致
    await refreshCategories();
  } catch (error) {
    uploadMessage.value = error instanceof Error ? error.message : "建类失败";
  }
}

/** 触发文件选择框；真实上传在 handleFilePick 里。 */
function pickFile() {
  // 没选分类时直接提示，不打开文件框（服务端也会拒绝）
  if (!selectedCategory.value) {
    uploadMessage.value = "请先选择分类";
    return;
  }
  fileInputRef.value?.click();
}

/** 文件选中后读取内容、base64 编码并上传。 */
async function handleFilePick(event: Event) {
  // 取出文件输入框里的第一个文件
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 input.value，允许连续选同一个文件
  input.value = "";
  if (!file) return;
  uploading.value = true;
  uploadMessage.value = "";
  try {
    // FileReader 异步读成 dataURL，再剥掉 base64 前缀
    const base64 = await readAsBase64(file);
    // 调上传接口；服务端只做收件，切片入库由 worker 推进
    await uploadKbFile({ filename: file.name, content: base64, category: selectedCategory.value });
    uploadMessage.value = `已上传 ${file.name}，等待处理`;
    // 立即刷新一次任务列表，让新任务出现
    await refreshTasks();
  } catch (error) {
    uploadMessage.value = error instanceof Error ? error.message : "上传失败";
  } finally {
    uploading.value = false;
  }
}

/** 把 File 读成纯 base64（去掉 data:...;base64, 前缀）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // dataURL 形如 data:text/markdown;base64,XXX，按第一个逗号切
      const result = String(reader.result ?? "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 拉取任务列表；轮询和上传后都调它。 */
async function refreshTasks() {
  try {
    const data = await listKbTasks();
    tasks.value = data.tasks;
    tasksError.value = "";
  } catch (error) {
    tasksError.value = error instanceof Error ? error.message : "加载任务失败";
  }
}

/** 对失败任务点重试：复位 queued 由 worker 续跑。 */
async function handleRetry(id: string) {
  try {
    await retryKbTask(id);
    await refreshTasks();
  } catch (error) {
    tasksError.value = error instanceof Error ? error.message : "重试失败";
  }
}

/** 删除一篇文档：确认后调删除接口并刷新列表与预览。 */
async function handleDelete(docId: string) {
  // 二次确认，避免误删（学习期不接撤销，删了就没了）
  if (!window.confirm("确认删除这篇文档？将同时清除其向量与块。")) return;
  try {
    await deleteKbDoc(docId);
    // 若正在预览被删文档，关闭预览面板
    if (previewDocId.value === docId) closePreview();
    await refreshTasks();
  } catch (error) {
    tasksError.value = error instanceof Error ? error.message : "删除失败";
  }
}

/** 展开/切换某篇文档的块预览。 */
async function togglePreview(docId: string) {
  // 再点同一行收起面板
  if (previewDocId.value === docId) {
    closePreview();
    return;
  }
  previewDocId.value = docId;
  previewLoading.value = true;
  previewChunks.value = [];
  try {
    const data = await listKbChunks(docId);
    previewChunks.value = data.chunks;
  } catch (error) {
    tasksError.value = error instanceof Error ? error.message : "加载块失败";
  } finally {
    previewLoading.value = false;
  }
}

/** 关闭块预览面板并清空数据。 */
function closePreview() {
  previewDocId.value = null;
  previewChunks.value = [];
}

/** 分类内提问：只搜选中分类，结果带来源。 */
async function handleSearch() {
  const q = question.value.trim();
  if (!q) return;
  if (!selectedCategory.value) {
    searchError.value = "请先选择分类";
    return;
  }
  searching.value = true;
  searchError.value = "";
  hits.value = [];
  try {
    const data = await searchKbCategory({ question: q, category: selectedCategory.value });
    hits.value = data.hits;
    // 无命中时如实提示，避免用户以为接口坏了
    if (data.hits.length === 0) searchError.value = "该分类下暂无相关内容";
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : "检索失败";
  } finally {
    searching.value = false;
  }
}

// 组件挂载：拉一次分类与任务，并启动任务轮询
onMounted(() => {
  void refreshCategories();
  void refreshTasks();
  // 每 2 秒轮询一次任务状态；轻量，列表规模小
  pollTimer = setInterval(() => void refreshTasks(), 2000);
});

// 组件卸载：清理轮询定时器，防止后台继续请求
onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<template>
  <div class="kb-panel">
    <!-- 区块一：分类选择 + 新建 + 上传入口 -->
    <section class="kb-block">
      <h3 class="kb-title">1 · 分类与上传</h3>
      <div class="kb-row">
        <select v-model="selectedCategory" class="kb-select" aria-label="选择分类">
          <option disabled value="">请选择分类</option>
          <option v-for="category in categories" :key="category.id" :value="category.name">
            {{ category.name }}
          </option>
        </select>
        <input
          v-model="newCategoryName"
          class="kb-input"
          placeholder="新建分类名"
          aria-label="新建分类名"
          @keydown.enter.prevent="handleCreateCategory"
        />
        <button class="kb-button" @click="handleCreateCategory">建类</button>
      </div>
      <div class="kb-row">
        <button class="kb-button primary" :disabled="uploading" @click="pickFile">
          {{ uploading ? "上传中…" : "上传 Markdown" }}
        </button>
        <span v-if="categoryHint" class="kb-hint">{{ categoryHint }}</span>
        <span v-if="uploadMessage" class="kb-hint">{{ uploadMessage }}</span>
      </div>
      <!-- 隐藏的文件输入：只接受 .md -->
      <input
        ref="fileInputRef"
        type="file"
        hidden
        accept=".md,.markdown,text/markdown"
        @change="handleFilePick"
      />
    </section>

    <!-- 区块二：任务列表（状态推进 / 重试 / 删除 / 预览入口） -->
    <section class="kb-block">
      <h3 class="kb-title">2 · 任务列表</h3>
      <p v-if="tasksError" class="kb-error">{{ tasksError }}</p>
      <p v-if="tasks.length === 0" class="kb-empty">暂无任务，先上传一篇 Markdown。</p>
      <ul v-else class="kb-task-list">
        <li v-for="task in tasks" :key="task.id" class="kb-task">
          <span class="kb-task-name">{{ task.filename }}</span>
          <span class="kb-task-cat">{{ task.category }}</span>
          <span class="kb-task-status" :data-status="task.status">
            {{ STATUS_LABEL[task.status] ?? task.status }}
          </span>
          <span class="kb-task-chunks">{{ task.chunkCount ?? 0 }} 块</span>
          <span v-if="task.error" class="kb-task-error">{{ task.error }}</span>
          <span class="kb-task-actions">
            <button class="kb-link" @click="togglePreview(task.docId)">
              {{ previewDocId === task.docId ? "收起预览" : "预览块" }}
            </button>
            <button
              v-if="task.status === 'failed'"
              class="kb-link"
              @click="handleRetry(task.id)"
            >
              重试
            </button>
            <button class="kb-link danger" @click="handleDelete(task.docId)">删除</button>
          </span>
        </li>
      </ul>
    </section>

    <!-- 区块三：块预览面板（点任务行的「预览块」展开） -->
    <section v-if="previewDocId" class="kb-block">
      <h3 class="kb-title">
        3 · 块预览
        <button class="kb-link" @click="closePreview">关闭</button>
      </h3>
      <p v-if="previewLoading" class="kb-empty">加载中…</p>
      <p v-else-if="previewChunks.length === 0" class="kb-empty">这篇文档还没有块（可能仍在切片）。</p>
      <ol v-else class="kb-chunk-list">
        <li v-for="chunk in previewChunks" :key="chunk.id" class="kb-chunk">
          <span class="kb-chunk-head">#{{ chunk.seq }} · {{ chunk.title || "（无标题）" }}</span>
          <pre class="kb-chunk-text">{{ chunk.text }}</pre>
        </li>
      </ol>
    </section>

    <!-- 区块四：分类内提问 -->
    <section class="kb-block">
      <h3 class="kb-title">4 · 分类内提问</h3>
      <div class="kb-row">
        <input
          v-model="question"
          class="kb-input grow"
          placeholder="在该分类里提问，结果会标出来源"
          aria-label="问题"
          @keydown.enter.prevent="handleSearch"
        />
        <button class="kb-button primary" :disabled="searching" @click="handleSearch">
          {{ searching ? "检索中…" : "提问" }}
        </button>
      </div>
      <p v-if="searchError" class="kb-hint">{{ searchError }}</p>
      <ul v-if="hits.length > 0" class="kb-hit-list">
        <li v-for="(hit, index) in hits" :key="`${hit.docId}-${hit.seq}`" class="kb-hit">
          <span class="kb-hit-head">
            #{{ index + 1 }} · {{ hit.source }} · 分数 {{ hit.score.toFixed(3) }}
          </span>
          <pre class="kb-chunk-text">{{ hit.text }}</pre>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* 面板容器：浮层内滚动，最大高度交给父级 overlay 控制 */
.kb-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* 每个功能区块的统一卡片样式 */
.kb-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
}
/* 区块标题：小号加粗，配右侧动作 */
.kb-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0;
  font-size: 13px;
  color: var(--text);
}
/* 一行操作区：弹性布局，窄屏自动换行 */
.kb-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 下拉与输入框共用一套边框风格 */
.kb-select,
.kb-input {
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--text);
  font-size: 13px;
}
/* 输入框允许撑满剩余宽度 */
.kb-input.grow {
  flex: 1;
  min-width: 200px;
}
/* 普通按钮 */
.kb-button {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}
/* 主按钮：强调色描边 + 浅底 */
.kb-button.primary {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
/* 提示文案：弱化色 */
.kb-hint {
  font-size: 12px;
  color: var(--muted);
}
/* 错误文案：危险色 */
.kb-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
/* 空状态文案 */
.kb-empty {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
/* 任务列表：去默认缩进 */
.kb-task-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 单行任务：网格对齐各列 */
.kb-task {
  display: grid;
  grid-template-columns: minmax(120px, 1.4fr) 0.8fr auto auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 12px;
}
/* 任务名可换行，避免长文件名撑破布局 */
.kb-task-name {
  overflow-wrap: anywhere;
  color: var(--text);
}
/* 分类标签弱化 */
.kb-task-cat {
  color: var(--muted);
}
/* 状态标签：可检索用强调色，失败用危险色 */
.kb-task-status {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--line);
  color: var(--text);
  font-size: 11px;
}
.kb-task-status[data-status="searchable"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.kb-task-status[data-status="failed"] {
  background: var(--danger-soft);
  color: var(--danger);
}
/* 块数 */
.kb-task-chunks {
  color: var(--muted);
}
/* 失败原因：可换行 */
.kb-task-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}
/* 行内操作按钮组 */
.kb-task-actions {
  display: flex;
  gap: 8px;
}
/* 链接式按钮：无边框 */
.kb-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font-size: 12px;
}
/* 危险操作用危险色 */
.kb-link.danger {
  color: var(--danger);
}
/* 块列表 */
.kb-chunk-list,
.kb-hit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 单个块 / 命中卡片 */
.kb-chunk,
.kb-hit {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
/* 块 / 命中头部：序号、标题、来源 */
.kb-chunk-head,
.kb-hit-head {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--muted);
}
/* 块原文：等宽展示，可换行，限高滚动 */
.kb-chunk-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--text);
}
</style>
