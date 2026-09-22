# server/rag/ — 可解释的 RAG（检索增强生成）

> 所属学习阶段：**阶段 3 · 可解释的 RAG**
> 学习计划文档：`stage3` 相关（已结）

## 模块职责

实现完整的 RAG 管线：文档切分 → Embedding 入库 → 向量检索 → Reranker 重排 → 组织 prompt → 生成回答。

## 文件说明

| 文件 | 职责 |
|------|------|
| `vectorStore.ts` | 纯 JS 向量库（内存 + JSON 持久化） |
| `embedding.ts` | 文本 → 向量（bge-large-zh-v1.5 本地推理）；`warmEmbed` 启动预热 |
| `retrieve.ts` | 向量检索 + 分数门槛判空 + rerank 调度 |
| `rerank.ts` | 交叉编码器重排（bge-reranker-base）；`RERANK_BATCH_SIZE` 分批；`warmRerank` |
| `warmup.ts` | `RAG_WARMUP` 开关下后台预热 embed + rerank |
| `prompt.ts` | 组织 RAG prompt（检索结果 + 用户问题 → 给模型的上下文） |
| `answer.ts` | RAG 问答入口（retrieve → prompt → LLM 生成） |
| `types.ts` | 类型定义（SearchHit、RetrievalJudgment 等） |

## API 端点

`POST /api/rag/chat`（`server/index.ts`）— 独立的资料问答路径
