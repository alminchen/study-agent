# server/rag/ — 可解释的 RAG（检索增强生成）

> 所属学习阶段：**阶段 3 · 可解释的 RAG**
> 学习计划文档：`stage3` 相关（已结）

## 模块职责

完整的 RAG 管线：文档切分 → Embedding 入库 → 向量检索 → Reranker 重排 → 组织 prompt → 生成回答。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `vectorStore.ts` | 纯 JS 向量库（内存 + JSON 持久化） |
| `embedding.ts` | 文本 → 向量（bge-large-zh-v1.5 本地推理）；`warmEmbed` 启动预热 |
| `chunker.ts` | Markdown 切分：标题层级建块，带 id / 标题 / 字数 |
| `retrieve.ts` | 向量检索 + 分数门槛判空 + rerank 调度 |
| `rerank.ts` | 交叉编码器重排（bge-reranker-base）；`RERANK_BATCH_SIZE` 分批；`warmRerank` |
| `warmup.ts` | `RAG_WARMUP` 开关下后台预热 embed + rerank |
| `prompt.ts` | 组织 RAG prompt（检索结果 + 用户问题 → 给模型的上下文）；有长期记忆时在「## 资料」之后追加独立的「## 用户长期记忆」小节 |
| `answer.ts` | RAG 问答入口（retrieve → prompt → LLM 生成）；记忆块由路由层检索一次后经 `options.memoryBlock` 传入 |
| `types.ts` | 类型定义：`SearchHit`、`RetrievalJudgment` 等 |
| `queryEnhance/` | 查询增强子模块（意图 / 扩写 / 路由 / 多路 / HyDE） |

## 检索流程

```text
用户问句
  → queryEnhance.resolveQueryForRetrieve   决定用哪句话去 embed
  → embed(queryUsed)                       向量召回
  → 分数门槛判空                            低分直接判空，不重排
  → rerank                                  交叉编码器重排
  → prompt                                  拼成「## 资料」小节
  → LLM                                     生成带 [n] 引用的回答
  → answer-style                            洗掉检索元信息
```

**判空在重排之前**：向量分不够就说明根本没命中，重排也救不回来，
先判空可以省掉一次重排模型调用。

## 查询增强子模块

`queryEnhance/` 负责「用户问句 → 拿去 embed 的问句」之间的增强层：
规则意图拆解、LLM 扩写、多知识库路由、多路召回合并、HyDE 假文档。

**这一层永远不会让整条 RAG 挂掉**：任何一步失败都回退原句检索，
状态写在 `meta.status`（`disabled` / `ok` / `fallback`）。

详见 `server/rag/queryEnhance/README.md`。

## 记忆怎么接进来

RAG 链路里的记忆块由路由层检索一次，通过 `options.memoryBlock` 传给 `answer.ts`，
再由 `prompt.ts` 拼成独立的「## 用户长期记忆」小节——
**不与「## 资料」混在一起**，避免模型分不清哪个是检索到的、哪个是记住的。

## API 端点

`POST /api/rag/chat`（`server/routes/ragChat.ts`）— 独立的资料问答路径

## 验证脚本

见 `scripts/README.md`：`rag:preview-chunks`、`rag:ingest`、`rag:search`、
`rag:test-empty`、`rag:preview-prompt`、`rag:ask` 等。

## 相关文档

- `docs/rag-query-enhance-notes.md`：查询增强笔记
- `docs/rag-input-output-guard-changelog.md`：RAG 防护改造
- `server/answer-style/README.md`：回答风格收敛
