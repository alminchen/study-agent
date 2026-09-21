# 检索前问句增强 · 学习笔记（对照计划）

> 对应：`LLM/rag-query-intent-rewrite-learning-plan.md`  
> 本文件只记本课进度与对照实验，**不改**旧 stage3 笔记。

---

## 单元 1 · 总链路图

```
用户原句 (UI 仍显示原句)
        │
        ▼
┌─────────────────────────────────┐
│ 本课新增：queryEnhance           │
│  ① parseIntent / rewriteQuery   │
│  失败 → fallback 用原句          │
└─────────────────────────────────┘
        │ rewritten（或原句）
        ▼
embed → LocalVectorStore.search → judgeRetrieval → rerank → prompt
        ▲
        └── 闸门 / 重排 / 回答：本课不改逻辑
```

| 块 | 失败会怎样 |
|----|------------|
| 扩写偏了 | Top 命中漂到无关块；回退原句可对比 |
| 路由错了（单元 5） | 漏召或搜错库 |
| Multi-Query 抬噪声（单元 6） | 候选池变吵，靠已有闸门收 |
| HyDE 假文档带偏（单元 7） | 假文档胡编 → 检索进沟 |

**纪律：** 一次只多开一个开关。当前代码默认 `RAG_QUERY_REWRITE` 关闭。

---

## 进度

| 单元 | 状态 | 落点 |
|------|------|------|
| 1 概念 | 通过 | 本页 |
| 2 规则意图 | 通过 | `queryEnhance/parseIntent.ts` |
| 3 LLM 扩写 | 通过 | `queryEnhance/rewriteQuery.ts` |
| 4 接入 + 回退 | 已接线 | `retrieveForAnswer` + `RAG_QUERY_REWRITE` |
| 5 多库路由 | 已接线 | `kbRoute.ts` + `RAG_KB_ROUTE` + 模拟 `hr_policy` |
| 6 Multi-Query | 已接线 | `multiQuery.ts` + `RAG_MULTI_QUERY` |
| 7 HyDE | 已接线 | `hyde.ts` + `RAG_HYDE` |

### 单元 7 怎么跑

```bash
# 只看假文档（需 LLM_API_KEY）
npm run rag:hyde -- "chunk 怎么切"

# 开 HyDE 检索（建议先关扩写 / 多路）
RAG_HYDE=1 npm run rag:search -- "chunk 怎么切"

# 期望：
# [hyde] status=ok chars=… preview=…
# CLI 打印 hydeDoc: …
# 对照关开关：Top 命中是否变化

# 关（默认）
npm run rag:search -- "chunk 怎么切"
```

纪律：假文档不是对用户的回答；不要为胡编假文档去改 `MIN_TOP_SCORE`；不要与 `RAG_MULTI_QUERY` 同开对照。

### 聊天窗口里怎么看

1. 切到 **资料问答**（不是普通对话）
2. 右侧「检索命中」面板顶部有 **问句增强（本课）**
3. 要看到效果，在服务端 `.env` 写入对应开关并**重启** `dev:server`，例如：
   ```
   RAG_QUERY_REWRITE=1
   # 或 RAG_KB_ROUTE=1 / RAG_MULTI_QUERY=1 / RAG_HYDE=1
   ```
   对照时一次只开一个。默认全关时也会显示 `status=disabled`。

### 单元 6 怎么跑

```bash
# 建议先关扩写 / 路由，一次只开 Multi-Query
RAG_MULTI_QUERY=1 npm run rag:search -- "chunk 怎么切"

# 期望日志：
# [multiQuery] status=ok n=2或3 ...
# [multiQuery] q1=... topIds=[...]
# CLI 打印 multiQuery: status=ok merge=max_score ...
# 对照关开关：候选集合是否多了其它路带来的块

# 关（默认）
npm run rag:search -- "chunk 怎么切"
```

纪律：不要为了「证明多路更好」去改 `MIN_TOP_SCORE`。

### 单元 5 怎么跑

```bash
# 1) 入库两份（模拟双库）
npm run rag:ingest
npm run rag:ingest -- docs-sample/stage5-hr-policy-notes.md

# 2) 开路由（建议先关扩写，一次只开一个开关）
RAG_KB_ROUTE=1 npm run rag:search -- "请假要交什么材料"
# 期望：kbRoute=hr_policy，命中 source=stage5-hr-policy-notes.md

RAG_KB_ROUTE=1 npm run rag:search -- "chunk size 和 overlap"
# 期望：kbRoute=notes，命中 stage3-rag-notes.md

# 3) 强制错库（验收硬过滤）
RAG_KB_ROUTE=1 RAG_KB_ROUTE_FORCE=notes npm run rag:search -- "请假要交什么材料"
# 期望：只能在 notes 里搜，制度块不应作为高分注入

# 4) none（天气口语）
RAG_KB_ROUTE=1 npm run rag:search -- "广州今天天气"
# 期望：message 含「路由为 none」，与「资料里没有相关内容」区分
```

### 单元 4 怎么跑对照

```bash
# 关（默认）：行为与改前一致
npm run rag:search -- "chunk 怎么切"

# 开：.env 写 RAG_QUERY_REWRITE=1，或：
RAG_QUERY_REWRITE=1 npm run rag:search -- "chunk 怎么切"

# 只看扩写 JSON
npm run rag:rewrite -- "chunk 怎么切"
RAG_QUERY_REWRITE=1 npm run rag:rewrite -- --resolve "chunk 怎么切"
```

填下面对照表 ≥5 组后再进单元 5。

---

## 单元 4 · 对照表（自己填）

开写前：`export RAG_QUERY_REWRITE=1`（或写入 `.env`）。

| 原句 | 关扩写 Top1 title | 开扩写 Top1 title | 结论 |
|------|-------------------|-------------------|------|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
