# `server/kb` · 模块说明

> 这是动态知识库（上传 → 切片 → 向量化 → 可检索）的内核目录。读完应该能回答四个问题——
> 这一层负责什么、每个文件干什么、失败时怎么退化、想改检索规则该动哪里。
>
> 整体学习计划见 `dynamic-kb-learning-plan.md`，可执行步骤见 `dynamic-kb-execution-plan.md`，
> RAG 双库合并衔接见 `docs/rag-kb-merge.md`，流程图见 `docs/rag-kb-merge-flow.svg`。
> 本文中的路径都是工作区内的**两级相对路径**（目录/文件）。

---

## 1. 这一层的定位

一句话：**把用户上传的 Markdown 变成「可向量检索的块」，并管理分类、任务状态与命中召回。**

| 负责 | 不负责 |
| --- | --- |
| 接收上传（校验 → 落盘原件 → 建 queued 任务） | 回答内容的正确性（那是 RAG / Judge 的事） |
| 后台切片 + 逐批 embedding（状态机推进） | 决定注入位置与 prompt 组装（在 `rag/` 与路由里） |
| 分类的建/查（检索硬边界） | 离线笔记库 `.chroma/my_notes.json` 的召回（在 `rag/`） |
| 块/向量/任务三表持久化（原子写 + 损坏自愈） | 模型供应商调用细节（在 `rag/embedding.ts`） |
| 检索（分类内硬过滤 / 全库扫 TopK） | 判空闸门与重排（在 `rag/retrieve.ts`） |
| 删除事务（向量 → 块 → 任务 → 原件） | 账号体系与多用户共享（当前匿名本机） |

### 与 RAG 的分层（不可混用）

> **动态知识库是「产品资产」，RAG 检索是「消费它」。**

- `server/kb/`：负责「把文档变成可检索的向量」这一**写/管**链路（上传、切片、入库、分类、删除）。
- `server/rag/`：负责「拿问句去检索」这一**读**链路，它通过 `askKnowledge()` 消费动态库结果，
  与离线 `.chroma/my_notes.json` 合并后再判空、重排、注入。

所以动态库的分类是**检索硬边界**：上传必须选类、检索必须带类（或显式全库搜），
块与向量都按 category 归属，避免跨分区互相污染。

---

## 2. 文件地图

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 线协议：`KbTask` / `KbTaskStatus` / `KbTaskStage` / `KbUploadBody` / 状态机枚举与校验谓词 |
| `categoryStore.ts` | 分类表：`categories.json`，建类（同名去重）、列类（createdAt 倒序）、原子写 |
| `taskStore.ts` | 任务表：`tasks.json`，建任务、认领（queued/chunked）、更新、重试、按 docId 删 |
| `chunkStore.ts` | 块表：`chunks.json`，按 docId 整篇替换、按 docId 读/计数/删 |
| `vectorStore.ts` | 向量表：`vectors.json`，按 docId 整篇替换、`searchByCategory` / `searchAll`、删除 |
| `uploader.ts` | 上传入口：校验（扩展名/大小/路径穿越）→ 落盘原件 → 建任务，秒回 |
| `worker.ts` | 后台循环：认领 → 切片（chunkMarkdown）→ 逐批 embed → 写向量 → searchable |
| `search.ts` | 检索入口：`askKnowledge({ question, category?, topK })`，embed 问句后分支检索 |

端点与接线不在本目录：

- `routes/kb.ts` —— `/api/kb/upload` · `/api/kb/tasks` · `/api/kb/chunks` ·
  `/api/kb/categories` · `/api/kb/search` · `/api/kb/delete` · `/api/kb/retry`；
- `server/index.ts` —— 启动时 `startKbWorker()` 拉起后台循环；
- `routes/ragChat.ts` —— RAG 问答透传 `category` 到 `answerFromDocs`；
- `rag/retrieve.ts` —— `kbHitToSearchHit()` 把动态库命中适配成 `SearchHit` 合并进离线库。

---

## 3. 数据流

### 3.1 上传链路（写，秒回）

```
POST /api/kb/upload { filename, content(base64), category }
  → uploader.validateUpload（扩展名 .md / ≤1MB / basename 防穿越 / 分类非空）
  → uploader.uploadOriginal
       ├─ taskStore.createTask（同分类+文件名复用 docId；新任务 id 每次独立）
       └─ 落盘 data/kb/uploads/{docId}/{filename}
  → 返回 queued 任务（前端开始轮询）
```

### 3.2 后台推进（状态机）

```
queued ──认领──> chunking ──切片──> chunked ──认领──> embedding ──入库──> searchable
   │                 │                 │                 │
   └─> failed(read)  └─> failed(chunk) └─> failed(embed)  └─> failed(embed)

runWorkerOnce（每 2s / 幂等）：
  ① 优先 claimQueuedTask → runChunkPhase（读原件 → chunkMarkdown → replaceChunksByDoc → chunked）
  ② 无 queued 再 claimChunkedTask → runEmbedPhase（读块表 → 逐批 32 块 embed → replaceVectorsByDoc → searchable）
```

### 3.3 检索链路（读，供 RAG / 知识库搜索）

```
askKnowledge({ question, category?, topK })
  → embed([question])   // 只 embed 问句这一句，绝不 embed 整库
  ├─ category 有值 → searchByCategory（分类内硬过滤）
  └─ category 无值 → searchAll（全库扫）
  → hits.map → KbAskHit[]（category/source/docId/seq/text/score，不带 embedding）
```

RAG 侧合并：`retrieve()` 调 `askKnowledge({ question, category, topK: candidateK })`，
经 `kbHitToSearchHit()` 适配后与离线库命中按 score 降序合并截断，再进判空闸门 + 重排。

---

## 4. 关键设计决策

### 决策 1：写 / 读两条链路分开

- 上传只做「收件」，切片与 embedding 全部交给后台 worker，请求必须秒回。
- 好处：用户感知的同步操作快；慢操作不阻塞请求；提问只读 searchable 的完整数据。

### 决策 2：状态机驱动，失败可定位可续跑

- `queued → chunking → chunked → embedding → searchable | failed`。
- 认领即置处理中（原子操作），天然防重入；每步失败落 `stage` + `error`，绝不静默。

### 决策 3：三表 + 原件四层存储，替换语义按 docId

- 分类表 `categories.json` · 任务表 `tasks.json` · 块表 `chunks.json` · 向量表 `vectors.json`。
- 同一「分类 + 文件名」复用同一 docId，重新上传整篇替换（清旧写新），库里永远最新一版。

### 决策 4：入库全部 embed 完才一次写盘

- `runEmbedPhase` 逐批（32 块）embed 攒齐，才调 `replaceVectorsByDoc` 一次写。
- 好处：中途失败向量表纹丝不动（不落半个文档），任务停 failed(embed)，重试整篇重入。

### 决策 5：原子写 + 损坏自愈

- 所有存储写「临时文件 + rename」原子替换，读坏 JSON 降级为空表并打警告。
- 进程内串行锁保证并发读改写不互相覆盖。

### 决策 6：分类可选（空 = 全库）

- `KbAskInput.category` 为 `string | null | undefined`；有值走 `searchByCategory`，无值走 `searchAll`。
- 好处：RAG 问答不选类时也能两套库同时召回（方案 B 合并式），用户不用判断该搜哪套。

---

## 5. 失败降级矩阵

| 环节 | 失败表现 | 任务落点 | 用户看到 |
| --- | --- | --- | --- |
| 上传校验 | 400 + 可读文案 | 不建任务 | 「只支持 .md / 超 1MB / 分类必选」 |
| 落盘原件 | 建任务后置 failed | `failed(read)` | 「原件落盘失败：…」 |
| 读原件 | 文件缺失 | `failed(read)` | 「读取原件失败：…」 |
| 切片 | 空块 / 抛错 | `failed(chunk)` | 「没有切出有效块 / 切片失败：…」 |
| 向量化入库 | embed 或写盘抛错 | `failed(embed)` | 「向量化入库失败：…」 |
| 存储文件损坏 | 读坏 JSON | 降级空表 + warn | 列表空但服务不崩 |
| 重试 | 非 failed 调重试 | 抛错拒绝 | 「只有 failed 任务可以重试」 |

---

## 6. 与 RAG 双库合并的接缝

本次衔接（方案 B）让动态知识库真正参与 RAG 问答召回，关键接缝：

- **检索入口**：`askKnowledge()` 支持分类可选，`searchAll()` 做全库扫；
- **适配函数**：`kbHitToSearchHit()` 把 `KbAskHit` 包成 `SearchHit`，
  `id/source` 带 `category__source__seq` 前缀，与离线同名文件天然不撞；
- **空库语义**：离线库空 → `[]`，动态库空 → `[]`，交给合并后的判空闸门统一决定；
- **展示**：`RagHitPanel.vue` 的 `splitSource()` 拆 `__`，分类显示为标签。

详见 `docs/rag-kb-merge.md`。

---

## 7. 想改某个行为该动哪里

| 想改什么 | 动哪里 |
| --- | --- |
| 上传大小 / 只收 .md | `uploader.ts` 的 `MAX_UPLOAD_BYTES` / `ALLOWED_EXTENSION` |
| 切片粒度 / overlap | `worker.ts` 调 `chunkMarkdown`（参数在 `rag/chunker.ts`） |
| 入库批大小 | `worker.ts` 的 `EMBED_BATCH_SIZE` |
| 轮询间隔 | `worker.ts` 的 `DEFAULT_INTERVAL_MS` |
| 分类去重规则 | `categoryStore.ts` 的 `createCategory` |
| 检索 TopK 上限 | `search.ts` 的 `topK` 收敛（1..20） |
| 全库 / 分类检索 | `vectorStore.ts` 的 `searchAll` / `searchByCategory` |
| 状态机推进 | `taskStore.ts` 的 `claim*` / `updateTask`，`worker.ts` 的 `run*Phase` |
