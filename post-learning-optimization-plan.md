# 全部学习计划完成之后：优化与清理执行计划

> **现在不要做。** 本文件是课后工程债清单，不是当前课。  
> 触发条件：阶段 5 剩余项（Evals、Token、错误恢复、Prompt Injection、多 Agent、部署）以及 **人工确认** 全部学完、验收通过之后，再单独开一轮「把 demo 收成能用的应用」。  
> 在那之前：继续按学习计划走，**禁止**为了快去改 ReAct、伪造 `tool_calls`、拆掉知识库开关。

载体：`step1-chat`。验收以现有 Evals 考卷为回归底线；本轮改完必须再跑一遍 eval，不能只看手感。

---

## 0. 为什么后置

学习阶段允许「为了讲清概念而叠一层」：

- 先 RAG 整页，再聊天里挂 `searchDocs`，再 prefetch 保证勾选必检索
- 先手写 for，再 LangGraph，两套并存
- 先 ToolTracePanel，再 LangSmith，span 会叠两层

这些在上课时是对的。学完之后叠在一起会出现：慢、路径重复、开关语义含糊。  
本计划专门拆这些，**不是**再开一课新概念。

---

## 1. 已证实的性能事实（2026-08 实测）

LangSmith 上同一套代码：

| 形态 | 大约耗时 | 瓶颈 |
|------|----------|------|
| 不出 `tool_calls`，直接 `reply` | ~1s | 单次 LLM |
| 出 `tool_calls` | 6s～40s+ | **第一次 `askModel`**（思考 + 生成 tool_calls） |
| `applyTools` | 0～1s | 可忽略 |
| 第二次 `askModel` | 0.6s～14s | 有时再进入思考 |

结论（写进本计划，避免以后又猜成「JSON 库太大」）：

- 慢的是 **带 tools 的思考模式 completion**，不是向量检索执行
- `chat-request` 上套两层 `askModel` 是 LangGraph 节点 + `traceAskModel` 重复打点，**不占墙钟**
- prefetch 若没打 span，会表现为根 span 比子 span 多出几秒，不要和 LLM 时间混为一谈

---

## 2. 执行顺序（学完后按 P0 → P2）

### P0：把「工具轮」从思考模式里拆开（延迟）

目标：出 `tool_calls` 的那一轮从十几秒降到接近「只跑 LLM」的量级。

待查（动手前先确认代理能力，不要猜）：

1. `LLM_BASE_URL` 是否支持按请求关 thinking（如 `thinking: { type: "disabled" }` 或等价字段）
2. 是否可对「选工具」和「写最终答案」用不同模型（非 reasoner vs reasoner）

建议落地（确认接口后再写代码）：

- **Turn 1（可能出 tool_calls）**：关 thinking / 用非思考模型
- **最终 reply 那一轮**：可保留 thinking（若仍要深度成文）
- 思考模式若仍开启：带 `tool_calls` 的 assistant **必须**回传 `reasoning_content`（空串也要带，已踩过 400）

不要做：

- 伪造 assistant+`tool_calls` 跳过第一轮（400 + 污染历史）
- 图外预路由直接答天气/时间（你已明确要走 LangGraph 循环）

验收：同一句「广州天气，顺便查查几点」，第一轮 `askModel` 明显下降；Evals 里时间/天气题仍绿。

---

### P0：知识库两条路收成一种语义（逻辑）

现状不合理：

| 入口 | 行为 |
|------|------|
| 页面「资料问答」 | `/api/rag/chat`：检索 → 拼 RAG prompt → 一次 LLM |
| 「搜索知识库」勾选 | `/api/chat`：`prefetchSearchDocs` 强制检索写入 **本轮 system**，同时 **仍把 `searchDocs` 交给模型** |

问题：

1. **同一能力两套编排**：用户很难讲清「资料问答」和「勾选搜索」差在哪
2. **prefetch + 仍挂 `searchDocs`**：检索已经做了，第一轮还在想要不要再调，延迟和重复检索都可能发生
3. **`toolSchemasForChat(includeSearchDocs)` 参数已空转**（当前实现把三个工具 schema 全发出去，开关不再过滤）——学完后必须修，否则「不勾选不把 searchDocs 交给模型」是假的
4. 开关语义靠 system 补丁（`SYSTEM_PROMPT_KB_ON` / `OFF`）硬扭，说明编排没把「本轮有没有资料」说清楚

学完后选定 **一种** 产品语义（三选一，不要再混）：

- **A. 勾选 = RAG 模式**：走 `/api/rag/chat` 或与之等价的「先检索再答」，聊天 ReAct 不再挂 `searchDocs`
- **B. 勾选 = 多一个工具**：取消 prefetch，只靠 ReAct 调 `searchDocs`（接受模型可能漏调；用 Evals 盯住）
- **C. 勾选 = 服务端必检索 + ReAct 只剩天气/时间**：保留 prefetch，**本轮不再把 `searchDocs` 发给模型**（延迟友好，和「工具还在项目里 / MCP 仍能调」不冲突）

验收：文档和 UI 文案一致；开/关/切换三类 eval 全覆盖；不再出现「勾选了但模型当没搜」或「关了还编章节」无测试。

---

### P1：检索链路按 demo 体量降配（延迟，次于 LLM）

仅在 P0 之后、且 trace 里 **prefetch / tool(searchDocs) 仍占数秒以上** 时做。

已知实现：`CANDIDATE_K = 20` 后 **串行** 跑 `bge-reranker-base` 20 次，再取 Top5。库很小，CPU/WASM 交叉编码仍可能贵。

可选（不要一次全上）：

1. 服务启动时预热 embedding + reranker（消灭首次加载）
2. 聊天路径候选数降到 8～10，资料问答页可保持 20（两条路径参数分开）
3. 能 batch 再 batch，不要为了快关掉重排课设（可做成环境变量开关）

验收：LangSmith 里检索相关 span 有名字（不要再藏在根 span 空白里）；第二次请求不再为冷启动买单。

---

### P1：观测与主链路对齐（逻辑）

不合理处：

- prefetch 没有独立 span，根时长对不上子节点
- LangGraph 的 `askModel` 与 `traceAskModel` 同名叠两层，排错时像跑了两次 LLM
- `/api/rag/chat` 与 `/api/chat` 的 trace 名未统一约定

学完后：

1. prefetch / `retrieveForAnswer` 打 child span（embed / search / rerank 可拆可不拆）
2. 只保留一层 LLM span 名称，避免 `askModel` 套 `askModel`
3. RAG 入口单独 trace 名，不和 chat-request 混筛选

---

### P1：请求形态与 UI 预期（逻辑）

- `requestCompletion` 固定 `stream: false`，页面却是流式 SSE：最终文字是整段到达再 `onDelta` 一次，和阶段 1「流式」课不一致
- 学完后：最终轮（无 tool_calls）可流式；工具轮保持非流式更稳（thinking + tool_calls 流式更难拼）

---

### P2：结构清理（不合理的并存）

学完后再删或合并，上课期间留着对照是有意的：

1. **`runConversation.forLoop.ts`**：现网已走 LangGraph。学完后标明「仅文档对照」或移到 `docs/`，避免两人改两套
2. **MCP `inputSchema` 与 `tools/schemas` 各写一份**：天气 city 描述两边可能漂。学完后单一来源
3. **system 里塞检索原文**：上下文变长、第二轮更贵。若选语义 C，保持 system 注入但截断 hit 长度；若选 A，走 RAG prompt 模块，不要再在 chat system 里复制一份
4. **MAX_CONTEXT_MESSAGES = 8** 含带资料口吻的旧 assistant：开关切换仍可能被历史带偏。学完后可对「本轮关知识库」做更硬的历史剥离（例如不把上一轮带 `[n]` 的 assistant 当事实源），用 eval `kb-toggle-off` 锁住
5. **页面两个入口**：资料问答 vs 搜索知识库。学完后 UI 只留一个主路径，另一个标明高级/兼容

---

## 3. 明确不做（即使学完也不要为了刷速度做）

- 图外意图识别替代 ReAct（已否决过）
- 伪造 `tool_calls` 骗过思考模式
- 为绿 eval 改 system 逼模型
- 把 Evals 课、Token 课、本计划混在同一 PR
- 生产构建当验收（仍禁止用 `npm run build` 代替类型检查 / eval 脚本）

---

## 4. 建议工单切分（学完后开任务用）

1. 调研代理 thinking 开关 / 双模型，出最小 PoC（只打日志，不改产品行为）
2. 修复 `toolSchemasForChat` 过滤；拍板知识库语义 A/B/C 并改 UI 文案
3. 工具轮关 thinking；跑 Evals
4. prefetch / retrieve 补 span；去掉重复 askModel 名
5. 最终轮流式（可选）
6. 检索预热与候选数（仅当 trace 证明检索仍贵）
7. forLoop 归档、MCP schema 单一来源、双入口 UI 收敛

每张工单必须：改动范围、回归的 eval id、不改什么。

---

## 5. 和总计划的关系

| 现在该学 | 学完再看本文件 |
|----------|----------------|
| Evals | 本计划的回归网 |
| Token / 成本页 | 可与 P0 一起看 usage，但成本页不是本计划交付 |
| 错误恢复 / Prompt Injection / 多 Agent / 部署 | 先学概念，不要提前用它们「优化」demo |
| 人工确认 | 仍按 `stage4-human-confirm-learning-plan.md`，与本计划独立 |
| 上传文档 RAG 完整应用 | 仍见 `dynamic-kb-learning-plan.md`，不要并进本轮 |

当前课请回到 **`stage5-evals-learning-plan.md`**。
