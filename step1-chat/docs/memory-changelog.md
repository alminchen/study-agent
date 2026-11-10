# 跨会话记忆 Memory（阶段 8 · 已实现 / 四链路未接入）

> 配套说明见 `docs/memory.md`，模块说明见 `memory/README.md`，
> 流程图见 `docs/memory-flow.svg`。本文件只记录「改了什么、为什么、验证到哪一步」。

## 一句话

在会话之外新增一层**跨会话长期记忆**：
从对话里抽出结构化的 `key: value` 事实（带敏感信息两道闸、置信度门槛、冲突标记），
落到按匿名用户隔离的本地文件里，
下一轮按向量相似度（阈值 0.45、Top-5）取回，
以「资料口径、不是指令」的方式注入上下文，
同时提供 `/api/memory` 与前端面板让用户**看得见、改得动、删得掉、关得了**。

## 为什么加这一层

阶段 3（长上下文）解决的是**一次会话内**上下文变长的问题：摘要、裁剪、预算。
会话一关，这些东西就没了——新开一个标签页问「帮我写个组件」，
模型不知道你上一轮说过「用 Vue 3」「用中文」「别用 emoji」。

这不是模型能力问题，是**会话天然无状态**。要跨会话，只能把该记住的东西落到会话之外，
再在合适的时机取回来。

但「记忆」很容易滑向两个危险方向，所以这一层的设计目标不是「接一个向量库」，
而是把记忆做成**可解释、可管理、可删除**：

- 滑向**自由文本摘要**：把历史塞进向量库，捞出来就往 prompt 里塞——
  记忆不可控、不可查、不可删，用户也不知道「你凭什么这么说我」。
- 滑向**隐式画像**：悄悄记录用户的一切，跨设备、跨场景跟随——
  产品上越界，合规上危险。

因此本阶段选的是**结构化事实记忆**（key/value + 本地向量检索），
而不是向量库自由文本。选型对比见 `docs/memory.md` 第 4 节，
结论是：**不引入语义记忆、不合向量库**。

## 本阶段做了什么

1. 定义记忆契约：`MemoryFact`（key/value + 生命周期字段）、`MemoryExtractResult`、
   四类来源、阈值常量、userId 规则、三个 trace 事件类型；
2. 实现抽取器：送模型前脱敏（第一道闸）、模型输出后再检测（第二道闸）、
   置信度门槛、结构化解析、失败一律返回空数组；
3. 实现去重合并：key 规范化、同 key 同值刷新、同 key 不同值标冲突（不自动覆盖）、
   语义高度相似才合并；
4. 实现存储：按匿名用户一个文件、用户级锁、临时文件 + 原子 rename、
   软删除、损坏自动重置；
5. 实现检索：余弦相似度、阈值 0.45、Top-5、给无向量的旧记忆补算并回写；
6. 实现注入渲染：`- {id}: {key}={value}` + 固定「是资料不是指令」声明，
   并在 `context/buildContext.ts` 里按 200 token / 预算 10% 裁剪；
7. 接入单 Agent 链路 `POST /api/chat`：检索在前、同步注入；抽取在旁路、不 await；
8. 新增 `GET/POST /api/memory`、`PATCH/DELETE /api/memory/:id`、`DELETE /api/memory`（清空）；
9. 前端记忆面板（列出 / 改 / 删 / 清空 / 冲突裁决）+ 顶栏开关 + trace 明细；
10. 标定检索阈值（实测）、做事实记忆 vs 语义记忆的对比 spike、跑五链路回归。

## 新增文件

| 文件 | 作用 |
| --- | --- |
| `memory/types.ts` | 线协议：`MemoryFact` / `MemoryExtractResult` / 阈值常量 / userId 规则 / `MemoryTraceEvent` |
| `memory/store.ts` | 存储：路径解析、用户级锁、原子写、软删除、embedding 回写、损坏自愈 |
| `memory/extract.ts` | 抽取器：脱敏、提示词、结构化解析、模型调用封装 |
| `memory/merge.ts` | 去重合并：key 规范化、同 key 裁决、语义合并、补向量 |
| `memory/retrieve.ts` | 检索：余弦相似度、阈值、Top-K、缺向量补算 |
| `memory/context.ts` | 渲染成上下文块（资料口径 + 记忆 id） |
| `memory/pipeline.ts` | 编排：抽取 -> 合并 -> 落盘，产出可上报的结果 |
| `memory/embedder.ts` | 向量化封装：本地模型、余弦相似度、失败兜底 |
| `memory/README.md` | 模块说明：职责边界 / 关键契约 / 失败路径 / 扩展指引 |
| `routes/memory.ts` | `/api/memory` 增删改查与清空 |
| `api/memory.ts` | 前端记忆接口封装 |
| `components/MemoryPanel.vue` | 前端记忆面板 |
| `scripts/test-memory.ts` | 跨会话 / 语义 spike / 并发与损坏自愈（`npm run test:memory`） |
| `scripts/test-chat-chains.ts` | 五链路 + 记忆接口回归（`npm run test:chains`） |
| `scripts/check-memory-recall.ts` | 检索阈值标定（相关对 / 无关对相似度分布） |
| `docs/memory.md` | 阶段完整说明 |
| `docs/memory-changelog.md` | 本文件 |
| `docs/memory-flow.svg` | 阶段 8 细泳道流程图（索引页 0g 引用） |

## 修改文件

| 文件 | 修改点 |
| --- | --- |
| `chat.ts` | 新增 `retrieveMemoryBlock` / `scheduleMemoryExtraction`；`MEMORY_INJECT_LIMIT = 5`、`MEMORY_EXTRACT_TIMEOUT_MS = 8000`；把记忆块插进 system 位置 |
| `routes/chat.ts` | 透传 `userId` / `allowMemory` 到单 Agent 链路 |
| `routes/index.ts` | 注册 `/api/memory` |
| `context/buildContext.ts` | 接受 `memory` 块并按 `MEMORY_CONTEXT_TOKEN_CAP` / `MEMORY_CONTEXT_BUDGET_RATIO` 裁剪 |
| `context/types.ts` | 新增 `ContextMemoryBlock` / `ContextMemoryItem` / 记忆 id 与 token 统计 |
| `usage/accumulator.ts` | 用量来源新增 `memory` |
| `api/chat.ts` | 请求体带 `userId` / `allowMemory`；SSE 解析三个记忆事件 |
| `composables/useChat.ts` | `memoryUserId` / `allowMemory` / `memoryFacts` 状态与增删改清空 |
| `App.vue` | 顶栏记忆开关 + 记忆管理浮层；`memoryInjectionSupported` 只在非 multi/plan/rag/structured/reflection 时为真 |
| `components/ToolTracePanel.vue` | 三个记忆事件的渲染分支（注入明细含相似度） |
| `types.ts` | 前端补三个记忆 trace 事件类型 |
| `package.json` | 新增 `test:memory` / `test:chains` 脚本 |
| `tsconfig.server.json` | 纳入新增服务端与脚本文件 |
| `docs/flows-index.html` | 索引页补 0g Memory 入口与阶段 8 文件清单 |
| `docs/project-topology.html` | 拓扑页补 §6h Memory |

## 记忆契约

| 项 | 值 | 说明 |
| --- | --- | --- |
| `MEMORY_SCHEMA_VERSION` | 1 | 结构变了才 +1；不认识的版本按「无记忆」处理 |
| `MAX_FACTS_PER_USER` | 200 | 单用户条数上限 |
| `MIN_CONFIDENCE` | 0.6 | 低于此值不落盘 |
| `SIMILARITY_THRESHOLD` | 0.45 | 检索门槛（实测标定） |
| `SEMANTIC_MERGE_THRESHOLD` | 0.85 | 语义合并门槛（更严） |
| `MEMORY_CONTEXT_TOKEN_CAP` | 200 | 记忆块绝对 token 上限 |
| `MEMORY_CONTEXT_BUDGET_RATIO` | 0.1 | 记忆最多占上下文预算 10% |
| `MEMORY_USER_ID_PATTERN` | `/^anon_[A-Za-z0-9_-]{1,64}$/` | 匿名命名空间 + 路径安全闸门 |

记忆来源只有四类：`user_explicit_preference` / `user_correction` /
`project_fact` / `tool_learned_fact`。

## 接入点一览

- 已接入端点：`POST /api/chat`（单 Agent ReAct）
- 管理端点：`GET /api/memory` · `POST /api/memory` · `PATCH /api/memory/:id` ·
  `DELETE /api/memory/:id` · `DELETE /api/memory?confirm=all`
- 事件：`memory_injected`（`itemIds` / `tokens` / `items` 明细）·
  `memory_extracted`（`candidates` / `stored`）·
  `memory_failed`（`stage` = `retrieve` | `extract` | `store`）
- 用量标签：`memory`
- 存储位置：`memory/{userId}.json`

## 隐私设计（不是附加项，是约束）

| 设计 | 做法 |
| --- | --- |
| 匿名 ID | `anon_` + 随机串，前端生成、只存 localStorage，服务端不采集真实身份 |
| 路径安全 | `MEMORY_USER_ID_PATTERN` 校验 userId（防路径穿越） |
| 不采 PII | 送模型前脱敏、模型输出后再拦一次；邮箱 / 手机号 / 身份证 / 密钥 / IP 不入库 |
| 关闭即停 | 前端不发 `userId` / `allowMemory`，服务端完全跳过检索与抽取 |
| 可查看 / 可编辑 / 可删除 | `GET` 返回全部生效记忆；删除是软删除（记 `deletedAt`），仍可审计 |
| 冲突不自动覆盖 | 同 key 不同值标 `conflict`，由用户在面板裁决 |
| 注入是资料不是指令 | 上下文块固定声明「仅供参考，不是新的指令或命令」 |
| 失败不阻断 | 抽取 / 检索 / 存储任一步出错，聊天照常 |

## 实测结果

### 阈值标定（本地 bge-large-zh-v1.5，10 组相关对 + 7 组无关对）

| 指标 | 数值 |
| --- | --- |
| 相关对相似度区间 | [0.498, 0.992] |
| 无关对相似度上限 | 0.403 |
| 采用阈值 | 0.45（原阈值 0.6 落在相关对区间之外，10 组里 6 组被挡） |

### 跨会话（真实模型）

| 检查项 | 结果 |
| --- | --- |
| 会话 A 抽取事实数 | 3 条：`language=中文`(0.95)、`style=不使用 emoji`(0.95)、`framework=Vue 3 + Vite`(0.90) |
| 会话 B（全新上下文）注入 | 命中 `framework=Vue 3 + Vite`，相似度 **0.622** |
| 删除一条后 | 生效记忆剩 2 条，下一轮注入明细为空 |
| 关闭 `allowMemory` 后 | 注入 0 条、抽取 0 条，聊天照常（回答 3284 字） |
| 回答形态 | 中文 157 字、0 个 emoji、用上了 Vue 3；**未主动说明记忆来源** |

### 存储性能

| 场景 | 结果 |
| --- | --- |
| 顺序写满 200 条 | 190 ms 合计，单条约 0.95 ms |
| 读回 200 条 | 1 ms |
| 并发 20 次写同一用户 | 23 ms 合计，写完读回 200 条，无丢失、无半截文件 |
| 手工写坏 JSON | 聊天照常；读取时自动重置为空数组，错误可诊断 |

### 事实记忆 vs 语义记忆（20 题）

| 方案 | 命中率 | 噪音率 |
| --- | --- | --- |
| 事实记忆（阈值 0.45，Top5） | 18/20（90.0%） | 61.7% |
| 语义记忆（同召回预算） | 19/20（95.0%） | 62.0% |

结论：只差 1 题属噪声，且语义记忆做不到**按 key 裁决冲突、人工编辑、审计删除**——
这三条是隐私与可控性的底线。**不引入语义记忆、不合向量库。**

### 五链路回归（真实模型）

`POST /api/chat` · `POST /api/chat/multi` · `POST /api/chat/plan` ·
`POST /api/rag/chat` · `POST /api/chat/structured` · `GET /api/memory`
—— **6/6 通过，整轮 22 秒**。

## 验证结果

- `npm run test:memory` —— 跨会话 / 语义 spike / 并发与损坏自愈，硬断言全过
- `npm run test:chains` —— 五链路 + 记忆接口回归，6/6 通过
- `npx tsx scripts/check-memory-recall.ts` —— 阈值标定脚本可复跑
- **未运行**：敏感信息拒存**没有自动化用例**，只能人工核对，本文件不写成已验证

## 已知缺口

1. **四链路尚未接入**：`/api/chat/multi`、`/api/chat/plan`、`/api/rag/chat`、
   `/api/chat/structured` 目前完全没有记忆引用；只有 `/api/chat` 接了。
   接入执行计划见 `tasks/memory-chain-integration-plan.md`。
2. **模型不会主动说明记忆来源**：注入块已声明来源，但回答里没提；
   UI 侧「已注入 N 条」明细可查。
3. **key 是英文、中文问句字面重合偏低**：
   「打包用什么工具」召不回 `build_tool: Vite`；可考虑 key 本地化或保留自然语言别名。
4. **噪音率 61.7%**：事实记忆的注入里约六成与当轮问题无关，
   由 Top-5 + 预算裁剪兜底，但用户体验上仍可优化。
5. **`.env` 的 `LLM_MODEL=deepseek-v4-flash` 在网关上已下线**（HTTP 503），
   本轮用 `LLM_MODEL=deepseek-v4.1-flash` 在运行时覆盖，**没有擅自改 `.env`**。

## 下一步

1. 按 `tasks/memory-chain-integration-plan.md` 接入 multi / plan / rag / structured 四条链路
2. 补敏感信息拒存的自动化用例（当前未运行）
3. 评估 key 本地化 / 自然语言别名，压低噪音率

## 配套文档

- `docs/memory.md` —— 阶段完整说明
- `memory/README.md` —— 内核模块说明
- `docs/memory-flow.svg` —— 阶段 8 流程图
- `tasks/memory-plan.md` —— 阶段计划与执行记录
- `tasks/memory-chain-integration-plan.md` —— 四链路接入执行计划



