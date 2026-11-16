# 动态知识库 · RAG 双库合并衔接（实现总结）

> 对应：`../rag-full-search-plan.md`（合并式方案 B）  
> 本文件只记本次衔接的**代码落点**与**设计决策**，不改旧 RAG 笔记。

---

## 一、为什么做这次衔接

原 RAG 问答链路只检索 `.chroma/my_notes.json`（离线灌入的笔记），
与页面上传的动态知识库 `data/kb/vectors.json` **完全独立**。后果：

1. 用户上传的文档，RAG 问答搜不到——因为检索层根本没接动态库。
2. 用户不知道选哪个分类——因为前端问答区把分类当**必选硬边界**。

本次把「动态知识库」真正接进 RAG 问答链路，交互、检索、展示三层打通。

## 二、架构选择：合并式（方案 B）

> 核心问题：不选分类时，无法判断该搜哪套库。**两套都搜**才保证不漏。

### 两套检索的现状对照

| 维度 | `retrieve()` / `searchDocs` | `askKnowledge()` / `searchAll` |
|------|---------------------------|------------------------------|
| 存储文件 | `.chroma/my_notes.json` | `data/kb/vectors.json` |
| 数据结构 | `StoredChunk`（source/title/text/seq/embedding） | `KbVectorRecord`（category/docId/source/seq/text/embedding） |
| 检索函数 | `store.search(queryVec, topK, { sources })` | `searchByCategory` / `searchAll` |
| 过滤维度 | 按 source（文件名） | 按 category（分类） |
| 来源标识 | source = 文件名 | category + source |

### 为什么不选路由式（二选一）

- 不选分类时不知道搜哪套，**两套都搜**才不漏。
- 避免维护 `source → 库` 映射规则，降低复杂度。
- 合并后统一走 RAG 已有的判空闸门 + 重排，质量保障一致。

## 三、关键设计决策

### 决策 1：分类可选（空 = 全库）

`KbAskInput.category` 从必填改成 `string | null | undefined`：

- 有值 → `searchByCategory`（分类内硬过滤）。
- 无值 / 空串 → `searchAll`（全库扫描）。

好处：单一入口两种模式，路由与 RAG 问答不用维护两套逻辑。

### 决策 2：适配函数统一两套命中形状

`kbHitToSearchHit()` 把 `KbAskHit` 包装成 `SearchHit`：

- `chunk.id` = `${category}__${source}__${seq}`（唯一标识，跨库去重）。
- `chunk.source` = `${category}__${source}`（保留分类边界，展示时能拆）。
- `chunk.title` / `chunk.text` / `chunk.seq` 原样透传。
- `embedding` 置空数组（重排用交叉编码器、前端不展示向量）。
- `chunk.category` = category（步骤 5 前端展示分类标签用）。

好处：两套库物理隔离，source 天然带分类前缀，与离线同名文件不撞。

### 决策 3：空库不再是硬错误

原 `retrieve()` 有「离线库空即抛错」的硬约束。合并式下 `.chroma/my_notes.json`
为空但动态库有数据时不应抛错。改为：空库返回 `[]`，靠合并后的判空闸门统一决定。

### 决策 4：候选数一致，合并后再截断

离线与动态两侧都用同一个 `candidateK` 召回，合并按分数降序后再截断，
避免一边候选过多挤掉另一边。

## 四、合并式调用流程

```
用户问句
   │
   ▼
embed(question)  ────────────────┐
   │                             │
   ▼                             ▼
LocalVectorStore.search      askKnowledge({ question, category?, topK })
   │                          ├─ category 有值 → searchByCategory
   │                          └─ category 无值 → searchAll
   ▼                             │
hitsFromNotes[]                  │
   │                             ▼
   │                    kbHitToSearchHit(hitsFromKb)  → SearchHit[]
   └──────────────┬──────────────┘
                  ▼
          合并 hitsFromNotes + hitsFromKbAsSearchHit
                  │
                  ▼
          按 score desc 排序，取前 candidateK → rawHits
                  │
                  ▼
          judgeRetrieval(rawHits) → 判空闸门（原逻辑不变）
                  │
                  ▼
          rerankHits(query, judged.hits, topK) → 输出 TopK
```

## 五、文件级改动清单

### 服务端 · 检索层

| 文件 | 改动 |
|------|------|
| `server/kb/search.ts` | `KbAskInput.category` 改可选；空值不抛错走 `searchAll` |
| `server/kb/vectorStore.ts` | 新增 `searchAll()`（全库扫，与 `searchByCategory` 对称） |
| `server/rag/retrieve.ts` | 新增 `kbHitToSearchHit()`；`retrieve()` 合并双库 + 排序截断；去掉空库抛错 |
| `server/rag/types.ts` | `StoredChunk` 加可选 `category?: string` |

### 服务端 · 透传通道

| 文件 | 改动 |
|------|------|
| `server/routes/ragChat.ts` | 解析请求体 `category`（可选），透传到 answer |
| `server/rag/answer.ts` | `answerFromDocs` options 加 `category`，透传给 `retrieveForAnswer` |
| `server/rag/retrieve.ts` | `RetrieveOptions` / `RetrieveForAnswerOptions` 加 `category`，三个 `retrieve()` 调用点透传 |

### 前端 · 交互与展示

| 文件 | 改动 |
|------|------|
| `src/api/rag.ts` | `AskRagParams` 加 `category?`；空值整字段不带 |
| `src/composables/useChat.ts` | 新增 `ragCategory` + `setRagCategory`；`askRag` 带 `category` |
| `src/App.vue` | 问答区新增「分类」下拉（全部 + 具体分类）；加载 `kbCategories` |
| `src/components/RagHitPanel.vue` | `splitSource()` + `sourcePartsById`，分类前缀拆成标签 |
| `src/index.css` | 新增 `.hit-category` 标签样式 |

## 六、关键实现要点

### `server/rag/retrieve.ts` · `retrieve()`

```ts
const hitsFromNotes =
  store.size === 0 ? [] : await store.search(queryVec, topK, { sources: options?.sources });

const hitsFromKb = await askKnowledge({
  question,
  category: options?.category ?? undefined,
  topK,
});

const hitsFromKbAsSearchHit = hitsFromKb.map(kbHitToSearchHit);

return [...hitsFromNotes, ...hitsFromKbAsSearchHit]
  .sort((a, b) => b.score - a.score)
  .slice(0, topK);
```

### `server/kb/search.ts` · `askKnowledge()`

```ts
const category = String(input.category ?? "").trim();
const hits = category
  ? await searchByCategory(category, queryVec, topK)
  : await searchAll(queryVec, topK);
```

### `server/kb/vectorStore.ts` · `searchAll()`

```ts
return records
  .map((record) => ({ record, score: cosine(record.embedding, queryVec) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, topK);
```

### 前端分类下拉（`App.vue`）

- 选「全部」→ `ragCategory=""` → 请求不带 `category` → 服务端全库搜两套库。
- 选具体分类 → 带上 `category` → 动态库硬过滤该分类。

### 前端命中面板（`RagHitPanel.vue`）

- source 含 `__` → 拆成「分类 + 文件名」，分类显示为蓝色胶囊标签。
- source 无 `__` → 整串按文件名显示（离线 notes 命中保持现状）。

## 七、验收清单

- [x] `askKnowledge` 不传 category 走 `searchAll`；传了走 `searchByCategory`。
- [x] `retrieve()` 合并两套库，按 score desc 排序后进判空闸门。
- [x] 动态库 source 带 category 前缀（`${category}__${source}`），与离线不撞。
- [x] `.chroma/my_notes.json` 为空时不抛错，只搜动态库也能出结果。
- [x] RAG 问答带 category 精确命中该类；不带全库搜两套库。
- [x] 动态库上传的文档能被 RAG 问答召回。
- [x] 命中面板显示来源分类（拆 `__` 格式）。
- [x] 离线 notes 命中仍只显示文件名，不受影响。
- [x] 前端问答区分类改可选（全部 + 具体分类）。
- [x] 离线 notes 的 RAG 问答行为不变。

## 八、不做什么（边界）

- 不改入库链路，不动两个存储文件格式。
- 不做分类名向量路由 / 关键词路由 / LLM 路由（后续可选优化）。
- 不改判空闸门 / 重排层（合并后的候选走原有逻辑）。

## 九、风险与注意

- **噪声风险**：全库搜可能让跨类块挤进 TopK，学习期接受，后续可加分类名向量路由优化。
- **数据隔离**：合并检索时不要把动态库的 category 误当成 RAG 的 source，两边标识要分开。
- **模型约束**：自测只用本地 `bge-large-zh-v1.5` embed + `deepseek`，禁止私自调 gpt/Claude。
- **测试自清理**：每轮自测后 `data/kb/` 数据必须归零。
