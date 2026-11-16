# 动态知识库全库检索 · 衔接 RAG 执行计划

## 背景

目前动态知识库的检索口（`askKnowledge`）把 `category` 设成**必填硬边界**，
RAG 问答链路检索的是 `.chroma/my_notes.json`（离线灌入），与动态知识库
`data/kb/vectors.json` **完全独立**。

结果：页面上传的文档，RAG 问答搜不到；用户在问答时也不知道该选哪个分类。

## 目标

- 交互层：RAG 问答的分类从**必选改成可选**，不选 = 全库搜。
- 检索层：`askKnowledge` 支持 `category` 可选——传了硬过滤，不传全库扫。
- 结果层：命中结果标明来源分类，用户能核对。

## 两套检索的架构选择：合并式（方案 B）

### 现状：两套完全独立的检索

| 维度 | `retrieve()` / `searchDocs` | `askKnowledge()` / `searchAll` |
|------|---------------------------|------------------------------|
| **存储文件** | `.chroma/my_notes.json` | `data/kb/vectors.json` |
| **数据结构** | `StoredChunk`（source, title, text, seq, embedding） | `KbVectorRecord`（category, docId, source, seq, text, embedding） |
| **检索函数** | `store.search(queryVec, topK, { sources })` | `searchByCategory` / `searchAll` |
| **过滤维度** | 按 source（文件名） | 按 category（分类） |
| **来源标识** | source = 文件名 | category + source |

### 为什么选合并式（不是路由式二选一）

- 用户不选分类时，无法判断该搜哪套库，**两套都搜**才能保证不漏。
- 避免维护 source → 库 的映射规则，降低复杂度。
- 合并后统一走 RAG 已有的判空闸门 + 重排，质量保障一致。

### 合并式的关键问题与解法

**问题一：两套结果怎么统一？**

- `LocalVectorStore.search()` 返回 `SearchHit`（`{ chunk: StoredChunk, score }`）。
- `askKnowledge()` 返回 `KbAskHit`（`{ category, source, docId, seq, text, score }`）。
- 解法：适配函数 `kbHitToSearchHit()` 把 `KbAskHit` 包装成 `SearchHit`：
  - `chunk.id` = `${category}__${source}__${seq}`（唯一标识，去重用）。
  - `chunk.source` = `${category}__${source}`（保留分类边界，展示时能拆）。
  - `chunk.title` / `chunk.text` / `chunk.seq` 直接透传。
  - `score` 直接透传。

**问题二：会不会重复召回同一个块？**

- 不会。两套库物理隔离（不同文件、不同记录结构），同一个块只会在一套里出现。
- 若用户上传的文件名与离线 notes 文件名相同，source 会撞。解法：
  - 动态库的 `chunk.source` 加 category 前缀（`交付验证类__notes.md`），与离线的 `notes.md` 天然不撞。
  - 适配函数已按 `category__source` 拼 source，天然区分。

**问题三：合并后怎么排序？**

- 两边都按 score（余弦相似度）排序，合并后 sort by score desc，取前 N 条进重排层。
- 重排层（`rerankHits`）按 query 对合并后的候选再打分，输出最终 TopK。

### 合并式检索的调用流程

```
用户问句 → embed
  ↓
retrieve(question, topK, { sources, category })
  ├─ LocalVectorStore.search(queryVec, candidateK, { sources })  → hitsFromNotes[]
  └─ askKnowledge({ question, category?, topK: candidateK })     → hitsFromKb[]
       ├─ category 有值 → searchByCategory（硬过滤）
       └─ category 无值 → searchAll（全库扫）
  ↓
kbHitToSearchHit(hitsFromKb)  → 转成 SearchHit 形状
  ↓
合并 hitsFromNotes + hitsFromKb → allHits[]
  ↓
按 score desc 排序，取前 candidateK → rawHits[]
  ↓
judgeRetrieval(rawHits)  → 判空闸门（原逻辑不变）
  ↓
rerankHits(query, judged.hits, topK)  → 重排输出 TopK
```

## 不做什么

- 不改入库链路，不动两个存储文件格式。
- 不做分类名向量路由 / 关键词路由 / LLM 路由（后续可选优化，本次不碰）。
- 不改判空闸门 / 重排层（合并后的候选走原有逻辑）。

## 执行步骤

### 步骤 1：`askKnowledge` 支持 category 可选

**做什么**
- `server/kb/search.ts` 的 `KbAskInput.category` 类型改为 `string | null | undefined`。
- 校验逻辑分支：
  - 有 category → 走现有 `searchByCategory`（硬过滤）。
  - 无 category / 空串 → 走全库检索（新增 `searchAll`）。

**为什么**
- 「不知道哪个分类」的场景下，用户不选类就应该能搜到，而不是被必填校验拒绝。

**好处**
- 单一入口两种模式，调用方（kb 路由 / RAG 问答）不用维护两套逻辑。

**验收**
- `curl POST /api/kb/search`，body 里去掉 category，仍能返回命中（按分数排 TopK）。

### 步骤 2：新增全库检索函数 `searchAll`

**做什么**
- 在 `server/kb/vectorStore.ts` 加 `searchAll(queryVec, topK)`：
  不按 category 过滤，直接对全部记录算余弦，返回 TopK。
- 复用现有 `searchByCategory` 的余弦计算与排序代码，只去掉 category 过滤。

**为什么**
- 与 `searchByCategory` 对称成对，代码结构清晰，避免在 search 里塞 if 分支。

**好处**
- 全库搜有独立函数，将来要做分类名向量路由 / 关键词路由，替换这一个函数即可。

**验收**
- `askKnowledge({ question: "...", topK: 5 })` 不传 category，返回跨分类的 TopK 命中。

### 步骤 3：RAG 问答入口透传可选分类

**做什么**
- `server/routes/ragChat.ts` 解析请求体里的 `category`（可选字段）。
- 透传到 `retrieveForAnswer` / `answerFromDocs` 的检索参数里。

**为什么**
- RAG 问答目前完全没有 category 概念，要接动态库必须先有透传通道。

**好处**
- 分类边界从交互层一路传到检索层，硬过滤语义不变。

**验收**
- `POST /api/rag/chat` body 带 `category: "交付验证类"`，能命中动态库该类的块。

### 步骤 4：RAG 检索层合并双库（合并式核心）

**做什么**
- 新增适配函数 `kbHitToSearchHit()`（放 `server/rag/retrieve.ts` 或新建 `server/rag/kbBridge.ts`）：
  - 输入 `KbAskHit`（`{ category, source, docId, seq, text, score }`）。
  - 输出 `SearchHit`（`{ chunk: StoredChunk, score }`）。
  - `chunk.id` = `${category}__${source}__${seq}`（唯一标识，去重用）。
  - `chunk.source` = `${category}__${source}`（保留分类边界，展示时能拆）。
  - `chunk.title` / `chunk.text` / `chunk.seq` 直接透传；`embedding` 置空数组（重排/前端不需要）。
  - `chunk.category` = category（步骤 5 展示用，需给 StoredChunk 加可选字段）。
- 修改 `server/rag/retrieve.ts` 的 `retrieve()`：
  - 保留 `LocalVectorStore.search()` → `hitsFromNotes`。
  - 新增 `askKnowledge({ question, category, topK: candidateK })` → `hitsFromKb`。
    - `category` 从 `RetrieveOptions` 透传（步骤 3 已加）。
    - 有值 → `searchByCategory`；无值 → `searchAll`（步骤 2 已加）。
  - `kbHitToSearchHit(hitsFromKb)` → 转成 SearchHit 形状。
  - 合并 `hitsFromNotes.concat(hitsFromKbAsSearchHit)`。
  - 按 score desc 排序，取前 `candidateK` → `rawHits`。
- `judgeRetrieval` / `rerankHits` 不动，走原有判空 + 重排。

**为什么**
- 这是「衔接」的核心：让动态知识库的向量真正参与 RAG 问答召回。
- 合并式保证两套库都能召回，用户不用判断该搜哪套。

**好处**
- 动态库的块直接享受 RAG 已有的问句增强、判空闸门、重排质量保障。
- 两套库物理隔离，不会重复召回同一个块（source 天然带 category 前缀区分）。

**关键风险与解法**
- **现有 `retrieve()` 有「库空即抛错」的硬约束**：`if (store.size === 0) throw`。
  合并式下若 `.chroma/my_notes.json` 为空但动态库有数据，不应抛错。
  解法：把抛错改成「空库返回 []」，靠合并后的 allHits 判空。
- **两边 source 去重**：适配函数已给动态库 source 加 category 前缀，天然不撞离线 source，
  合并时无需额外去重。
- **candidateK 一致**：两边都用同一个 candidateK（如 20）召回，合并后再截断，
  避免一边候选过多挤掉另一边。

**关键改动点**
- `server/rag/retrieve.ts`：`retrieve()` 函数体（新增 askKnowledge 调用 + 合并 + 排序 + 去掉空库抛错）。
- 新增 `kbHitToSearchHit()` 适配函数（可放同文件或 `server/rag/kbBridge.ts`）。
- `server/rag/types.ts`：`StoredChunk` 加可选 `category?: string`。

**验收**
- 上传一篇文档到动态库，去 RAG 问答问相关问题，命中面板能召回对应块。
- 离线 notes 的原有问答仍能召回（`stage3-rag-notes.md` 的问题）。
- `.chroma/my_notes.json` 为空时不再抛错，只搜动态库也能出结果。

### 步骤 5：命中结果标来源分类

**做什么**
- 步骤 4 适配函数已给动态库块的 `chunk.source` 加了 category 前缀（`${category}__${source}`），
  并给 `StoredChunk` 加了 `category?: string`。
- 前端 `RagHitPanel.vue` 展示 source 时：
  - source 里有 `__` → 拆成「分类 + 文件名」展示，分类单独显示为标签。
  - 没有 `__` → 只展示文件名（离线 notes 命中，保持现状）。

**为什么**
- 用户不选类时是全库搜，结果必须能看出「这块来自哪个分类」，否则没法核对过滤是否生效。

**好处**
- 对应学习计划步骤 8 验收点 4「结果可看出源」。

**关键改动点**
- `src/components/RagHitPanel.vue`：source 展示逻辑加 `__` 拆分 + category 标签。

**验收**
- RAG 问答命中面板上能看到命中块的来源分类。
- 离线 notes 的命中仍只显示文件名，不受影响。

### 步骤 6：前端问答区分类选择改可选

**做什么**
- `App.vue` 问答区的分类选择（如果目前必选）改成「全部」选项 + 具体分类选项。
- 选「全部」→ 请求不带 category；选具体分类 → 带上。

**为什么**
- 交互层是入口，必选约束不松，后端改了也用不上。

**好处**
- 用户主动选类是「精确检索」，不选是「全库兜底」，两种模式共存。

**验收**
- 问答区不选分类，问动态库已有文档的问题，仍能召回。

### 步骤 7：回归自检 + 数据清理

**做什么**
- 跑一遍：上传测试文档 → RAG 问答召回 → 命中面板显示分类 → 删除文档 → 再问召回为空。
- 确认离线 notes 的 RAG 问答不受影响（`stage3-rag-notes.md` 原有问题仍能命中）。
- 清理测试数据：`data/kb/` 下四个 json 文件归零、`uploads/` 清空。

**为什么**
- 衔接后两条检索链路都要能跑，且不能互相污染。

**验收**
- 动态库上传的文档 RAG 能召回、删除后不再召回。
- 离线 notes 的原有问答行为不变。

## 验收清单

- [ ] `askKnowledge` 不传 category 时走 `searchAll`（全库搜），传了走 `searchByCategory`（硬过滤）。
- [ ] `retrieve()` 合并两套库结果，按 score desc 排序后进判空闸门。
- [ ] 动态库 source 带 category 前缀（`${category}__${source}`），与离线 source 不撞。
- [ ] `.chroma/my_notes.json` 为空时不抛错，只搜动态库也能出结果。
- [ ] RAG 问答带 category 时精确命中该类；不带时全库搜两套库。
- [ ] 动态库上传的文档能被 RAG 问答召回。
- [ ] 命中面板显示来源分类（拆 `${category}__${source}` 格式）。
- [ ] 离线 notes 的命中仍只显示文件名，不受影响。
- [ ] 前端问答区分类改可选（「全部」+ 具体分类）。
- [ ] 离线 notes 的 RAG 问答行为不变。
- [ ] 测试数据清理干净（`data/kb/` 归零、`uploads/` 清空）。

## 风险与注意

- **噪声风险**：全库搜可能让跨类块挤进 TopK，学习期接受，后续可加分类名向量路由优化。
- **数据隔离**：合并检索时不要把动态库的 category 误当成 RAG 的 source，两边标识要分开。
- **模型约束**：自测只用本地 `bge-large-zh-v1.5`，禁止私自调 gpt/Claude。
- **测试自清理**：每轮自测后 `data/kb/` 数据必须归零。

## 推荐执行顺序

1 → 2 → 3 → 4 → 5 → 6 → 7，按依赖顺序，一步一验收。
先做后端检索层（1/2/3/4），再做前端展示层（5/6），最后回归（7）。

每步执行前向用户确认，避免越权。
