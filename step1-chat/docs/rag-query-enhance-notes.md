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

**纪律：** 对照实验一次只开一个召回增强开关。日常默认见 §单元 8（REWRITE + KB_ROUTE）。

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
| 8 策略对照与默认 | 通过 | 本节 + `npm run rag:compare-enhance` |
| 9 稳健性收齐 | 通过 | 本节 + `npm run rag:test-enhance-fallback` |

---

## 单元 8 · 策略对照与默认

### 对照怎么跑

```bash
# 路由开着；三招互斥：single / multi / hyde（脚本内关 REWRITE）
npm run rag:compare-enhance
# 或自定义问句：
npm run rag:compare-enhance -- "chunk 怎么切" "请假要交什么材料"
```

### 实测摘要（路由=1，REWRITE 关）

| 问句 | single Top1 | multi Top1 | hyde Top1 | 观察 |
|------|-------------|------------|-----------|------|
| chunk 怎么切 | 0.51 切片注意事项（判空） | 0.60 overlap 接缝（过闸） | 0.89 **可解释验收**（题偏） | Multi 救漏召；HyDE 分高但主题漂 |
| 请假要交什么材料 | 0.64 请假材料（对） | 0.63 同（对） | 0.91 同（对） | 三招都对；HyDE 最费 Token |
| 不要把整篇…冒充 RAG | 0.66 §10 不要做的事（对） | 0.70 同（对） | 0.87 **可解释验收**（题偏） | 短标题问句单路已够；HyDE 易漂 |

### 何时用哪招

| 招 | 适合 | 代价 / 风险 |
|----|------|-------------|
| **单路**（±扩写） | 日常默认；口语经扩写对齐库内词 | 扩写 1 次 LLM；扩写偏了会漂 |
| **Multi-Query** | 单路漏召、短口语、同义说法多 | embed×N；候选变吵 |
| **HyDE** | 短问对长块向量对不齐、且主题边界清楚 | 再 1 次 LLM；假文档胡编 → 分高题偏 |
| **路由** | 多 source / 多库（笔记 vs 制度） | 规则错会漏库；`none` 必须能区分判空 |

### 本课默认策略（书面结论）

**默认：`RAG_QUERY_REWRITE=1` + `RAG_KB_ROUTE=1`；`RAG_MULTI_QUERY` / `RAG_HYDE` 默认关。**

理由（对照上表 + 库形态）：
1. **延迟 / Token**：日常只要扩写 1 次 LLM + 单路 embed；Multi/HyDE 额外成本高  
2. **稳定性**：HyDE 在笔记库上多次「分高题偏」；不适合默认  
3. **库形态**：已有 notes + hr_policy 模拟双库，路由硬过滤价值明确  
4. **漏召兜底**：需要时再手动 `RAG_MULTI_QUERY=1`（一次只开一招）

`.env` 当前即按此默认；换招只改对应开关并重启 server。

---

## 单元 9 · 稳健性收齐

### 回退表

| 故障 | 触发示例 | status | 行为 | 是否抛穿主链 |
|------|----------|--------|------|----------------|
| 扩写失败 | 无 Key / `MOCK_MODE=1` / 坏 JSON | `rewrite=fallback` | `queryUsed=原句`，继续检索 | 否（catch 在 resolve） |
| 扩写关闭 | 未设 env | `rewrite=disabled` | 与改前一致用原句 | 否 |
| 路由关闭 | 未设 env | `kbRoute=disabled` · `all` | 全库搜 | 否 |
| 路由 none | 天气口语 / `FORCE=none` | `route=none` | **跳过 search**，message 含 none | 否 |
| HyDE 失败 | `MOCK_MODE=1` / 假文档过短 | `hyde=fallback` | `embedText=queryUsed` 再搜 | 否 |
| HyDE+Multi 同开 | 两开关都 1 | `multi=skipped` · HyDE 优先 | warn；本轮不跑多路 | 否 |
| Multi &lt;2 路 | 拼不出两句 | `multi=skipped` | 退回单路 retrieve | 否 |

### 故障注入验收

```bash
npm run rag:test-enhance-fallback
```

已覆盖 ≥3 种（实测 4 项全 PASS）：
1. rewrite MOCK → `fallback`  
2. hyde MOCK → `fallback`  
3. `FORCE=none` → 跳过检索 + 可区分 message  
4. HyDE+Multi 同开 → `multi=skipped`

调试字段：原句 / queryUsed / route / multi queries / hydeDoc / hits —— CLI `rag:search` 与右侧「问句增强」面板均可见。

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
