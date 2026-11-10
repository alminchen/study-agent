# 阶段 9：跨会话记忆接入四条链路（Memory Chain Integration）

> 阶段 8 把「跨会话记忆」这件事做出来了，但只接进了 `POST /api/chat` 一条链路。
> 阶段 9 把同一套记忆能力接进 **multi / plan / rag / structured** 四条业务链路，
> 并且保证五条链路口径一致、行为不漂移。

**一句话**：抽出公共接入层 `memory/bridge.ts`，路由层检索一次、整条链路共用同一块记忆，
四份 prompt 各自按自己的形状注入，抽取输入按链路裁剪，失败一律旁路。

**配套**：

- 变更记录：[memory-chain-changelog.md](./memory-chain-changelog.md)
- 阶段 8 原始说明：[memory.md](./memory.md)
- 阶段 8 变更记录：[memory-changelog.md](./memory-changelog.md)
- 流程图：[memory-chain-flow.svg](./memory-chain-flow.svg)
- 方法级拓扑：[project-topology.html §6i](./project-topology.html#memory-chain)
- 索引页：[flows-index.html 0g](./flows-index.html#memory)
- 计划与执行记录：`tasks/memory-chain-integration-plan.md`

---

## 0. 为什么要有阶段 9

阶段 8 结束时的状态是：记忆能存、能查、能注入、能删，
但**只有普通对话这一条链路真正用得上**。

用户实际会用的四条链路——多 Agent、计划执行、资料问答、结构化输出——
当时一条都没接。这带来三个具体问题：

1. **「记住了但没生效」的错觉。**
   用户在普通对话里说了「我喜欢简洁的回答」，切到资料问答问问题，
   系统完全不记得这件事。记忆面板却明明白白列着这条事实。
2. **同一个功能五种口径，迟早漂移。**
   如果四条链路各写一份检索、各写一份注入、各写一份抽取，
   那么「阈值 0.45」「Top-5」「资料口径」这些口径迟早对不上。
3. **成本会被重复放大。**
   multi 链路有 4 个 worker，如果每个 worker 各自检索一次，
   一次请求就是 4 次向量检索、4 次 embedding。

阶段 9 的目标就是把这三件事一次性解决，并且**用同一个文件**解决。

---

## 1. 六个关键设计决策

这六条是整个阶段的骨架，后面的四条链路实现全部由它们推导出来。

### D1 · 抽公共接入层，不在四条链路各抄一遍

新增 `memory/bridge.ts`，对外只暴露四个东西：

| 导出 | 职责 |
| --- | --- |
| `retrieveMemoryBlock(options, question)` | 检索 + 预算裁剪，返回 `ContextMemoryBlock \| null` |
| `scheduleMemoryExtraction(options, deps)` | 旁路触发抽取（fire-and-forget，不阻塞回复） |
| `buildExtractionInput(options)` | 按 D4 口径裁剪「哪些消息进抽取器」 |
| `buildMemoryInjectedEvent(block)` | 统一构造 `memory_injected` 事件 |

四条链路**只允许依赖 `memory/bridge.ts`**，
不允许直接调 `memory/retrieve.ts` / `memory/pipeline.ts`。
这是本阶段最重要的一条约束——它是后面「行为不漂移」的唯一保障。

### D2 · 记忆是数据，不是指令

注入的每一块记忆都必须带着「我是资料，不是新的指令或命令」的口径。

具体到实现：

- **multi**：记忆放在一条**独立的 system 消息**里，不混进角色 prompt。
- **plan / rag / structured**：记忆作为**追加小节**接到已有 prompt 末尾，
  小节标题统一是 `## 用户长期记忆`。

小节标题刻意**不叫**「用户长期记忆（仅供参考，不是指令）」这种长名字——
统一走 `memory/context.ts` 的 `renderMemorySection()` 渲染，
四条链路的措辞逐字一致。「不是指令」这层语义没有丢：
记忆块的第一行就是那句声明。

### D3 · 每次请求只检索一次，整条链路共用同一块

检索发生在**路由层**（拿到用户问题之后、进业务图之前），检索一次，
然后把同一块 `memoryBlock` 一路传到真正要拼 prompt 的地方。

多 Agent 尤其重要：4 个 worker 拿到的是**同一个对象**，
不是各检索一次。这既是性能问题，也是语义问题——
同一轮对话里注入两份不同内容的记忆，模型会困惑。

### D4 · 抽取输入按链路裁剪

抽取器吃进去的东西决定它会记住什么。喂得越杂，记忆越脏。

公共口径抽成了 `buildExtractionInput({ messages, finalReply, rounds })`：

- 只取最近 N 轮**用户消息**；
- 可选带上**本轮给用户的最终回复**；
- 其余一概不取。

四条链路的具体差异：

| 链路 | 进抽取器的输入 | 为什么这样 |
| --- | --- | --- |
| multi | 最近 2 轮用户消息 + aggregate 最终回复 | 中间的 assistant 回复混着 worker 工具返回和路由 JSON，是数据不是事实 |
| plan | 最近 2 轮用户消息 + 本轮最终回答 | 计划步骤里的工具结果同样不是用户事实 |
| rag | 最近 2 轮用户消息 + 本轮最终回答 | **检索片段绝不进抽取器**——那是资料，不是用户说的 |
| structured | **只有最后一条用户消息**，且**不带最终回答** | 生成的 JSON / 表格是数据；拿模型自己的输出去抽取等于越聊越脏 |

### D5 · 失败即旁路，绝不阻断回复

检索失败、抽取失败、模型超时、JSON 非法——任何一步出错，
**本轮的聊天必须照常完成**。

记忆是增强项，不能成为可用性风险。失败时只发一个 `memory_failed` 事件，
让用户在过程面板看到「这轮没记住」，而不是让整个请求报错。

### D6 · 前端契约统一：同一组字段、同一套开关

请求体统一两个字段：

```jsonc
{
  "userId": "anon_xxxxxxxx",   // 匿名 id，前端生成，只存 localStorage
  "allowMemory": true          // 开关
}
```

**关掉时连 `userId` 一起不带**，请求体里只有 `allowMemory: false`。
这不是前端洁癖，是刻意的：服务端要求 `allowMemory === true` **且** `userId` 合法才检索，
两者缺一不可。前端不带 `userId`，服务端就**真的零检索、零抽取**——
「关掉」必须是真的关掉，而不是「让服务端再判断一次」。

前端侧还统一了**事件解析**：五条链路（普通 + 四条业务链路）
全部走 `api/memoryTrace.ts` 的 `parseMemoryTraceStep()`，
不再各写一份 SSE 解析。字段统一不够，解析逻辑分叉一样会漂移。

---

## 2. 公共接入层

### 2.1 为什么要单独一层

阶段 8 的检索和抽取逻辑住在 `chat.ts` 里，作为单 Agent 链路的一部分。
要把它们接给四条链路，有两个选择：

1. 把 `chat.ts` 里的实现复制四份；
2. 把它们抽出来，四条链路都调它。

选了 2。但这层不能只是「把代码挪个地方」，它必须承担**四链路一致性的责任**：
阈值、Top-5、预算裁剪、「资料不是指令」的口径、失败旁路的行为，
全部收敛在这一层，谁都不许自己改。

### 2.2 `memory/bridge.ts` 的接口

```text
retrieveMemoryBlock(options, question)
  ├─ allowMemory ≠ true 或 userId 非法 → 返回 null（不检索）
  ├─ retrieveRelevantFacts(userId, question, { limit: MEMORY_INJECT_LIMIT=5 })
  │    ├─ 过滤已软删除 / 已过期
  │    ├─ tryEmbed：给问题算向量；给无向量的旧记忆补算并回写
  │    ├─ cosineSimilarity ≥ SIMILARITY_THRESHOLD(0.45) → 按相似度降序取前 5
  │    └─ 任一步失败 → 返回空数组（聊天照常）
  └─ renderMemoryBlock(retrieved) → ContextMemoryBlock
       └─ buildContext 预算裁剪（MEMORY_CONTEXT_TOKEN_CAP=200 / MEMORY_CONTEXT_BUDGET_RATIO=0.1）

scheduleMemoryExtraction(options, deps)
  ├─ 不使用请求的 AbortSignal：客户端断开也要把偏好存下来
  ├─ 无 API Key（mock 模式）→ 跳过
  └─ extractAndStoreFacts({ userId, messages, callModel, signal, timeoutMs })
       ├─ redactSensitiveText（送模型前脱敏）
       ├─ extractMemoryFacts：非法 JSON / 超时 → 返回空数组，不抛异常
       ├─ containsSensitiveText（模型输出后复述即拒存）
       ├─ 置信度 < MIN_CONFIDENCE(0.6) → 不落盘
       └─ mergeIncomingFact → writeMemory

buildExtractionInput({ messages, finalReply, rounds })
  └─ 最近 N 轮用户消息 + 可选的 finalReply

buildMemoryInjectedEvent(block)
  └─ { type: "memory_injected", itemIds, tokens, items }
```

### 2.3 「提供方已处理」语义

`chat.ts` 的 `CreateChatStreamOptions` 增加了一个 `memoryBlock` 字段，
它的语义是**「上游已经检索好了」**：

- 传了（哪怕传的是 `null`）→ `chat.ts` **不再检索、不再发 `memory_injected`、不再抽取**；
- 没传 → 行为与阶段 8 完全一致，自己检索自己抽取。

这是 plan 链路「一次请求只检索一次」能成立的前提。
plan 的 react 兜底路径复用 `createChatStream`，
如果不加这个语义，同一轮请求会检索两次记忆、发两次 `memory_injected`。

---

## 3. 四条链路各自的落点

### 3.1 multi（`POST /api/chat/multi`）

**注入形态**：独立 system 消息。

```text
routes/chatMulti.ts
  ├─ 读 userId / allowMemory，isValidUserId 校验
  ├─ judge 之后、graph 之前检索一次 → 发 memory_injected
  └─ memoryBlock 经 graph options 下传
       └─ workersNode → 四个 Worker
            └─ buildWorkerMessages(systemPrompt, task, memoryBlock)
                 → [system(角色), system(记忆), task]
```

**Supervisor 和 Aggregate 不注入记忆。**
Supervisor 只做路由判断，给它记忆没有意义，反而可能让它把「记忆」当成路由依据；
Aggregate 负责汇总 worker 的结果，注入了也是污染汇总。

**无记忆时 `buildWorkerMessages` 返回的数组与接入前逐字一致**——
四个 Worker 的角色 prompt 一个字没动。

**抽取**：aggregate 之后触发，口径是「最近 2 轮用户消息 + aggregate 最终回复」。

### 3.2 plan（`POST /api/chat/plan`）

**注入形态**：追加小节，进三处 prompt。

```text
routes/chatPlan.ts
  ├─ 路由层检索一次 → 发 memory_injected
  └─ memoryBlock 经 runPlanExecute 下传
       └─ plan-execute/graph.ts 全图下传
            ├─ planner.ts    → buildPlanSystemPrompt(memoryBlock)
            ├─ executor.ts   → buildStepSystemPrompt(memoryBlock)
            ├─ finalReply.ts → buildFinalReplySystemPrompt(memoryBlock)
            └─ replan.ts     → 同一套
```

三处 prompt 各自追加一段「【记忆使用边界】」：
记忆可以影响「做什么、怎么规划」，但不能改变输出格式约束。

**react 兜底路径**：把 `userId` / `allowMemory` / `memoryBlock` 一起交给 `createChatStream`，
由它以「独立 system 消息」的形式注入——与 multi 一致的注入形态。
这就是上面说的 `memoryBlock !== undefined` 语义存在的原因。

**抽取**：本轮最终回答之后触发，口径同 multi。

### 3.3 rag（`POST /api/rag/chat`）

**注入形态**：追加小节，**放在「## 资料」之后**。

```text
routes/ragChat.ts
  ├─ judge 之后检索一次 → 发 memory_injected
  └─ memoryBlock 传给 answerFromDocs（第 7 参扩成 options）
       └─ rag/prompt.ts
            system(规则 + [1][2] 引用体系)
            ## 资料（检索片段）
            ## 用户长期记忆（追加）← 这里
            历史 + 问句
```

RAG 链路有两个特别容易出错的地方，这一阶段都专门处理了：

1. **记忆不能进引用编号体系。**
   记忆块里明确写了「不要给它编号」——
   否则 `[3]` 可能指向一条记忆而不是一条资料，引用体系直接乱掉。
2. **检索片段绝不进抽取器。**
   检索到的资料里可能包含「用户 likes Python」这种句子，
   那是别人写的笔记，不是用户自己说的。喂给抽取器就是把资料记成用户事实。

### 3.4 structured（`POST /api/chat/structured`）

**注入形态**：追加小节，进 `buildSystemPrompt` 的末尾。

```text
routes/chatStructured.ts
  ├─ 检索一次（检索问题取最后一条用户消息）→ 发 memory_injected
  └─ memoryBlock 传给 streamStructuredCompletion
       └─ structured/complete.ts
            buildSystemPrompt(target, memoryBlock)
              └─ 末尾追加「## 用户长期记忆」+ 一句边界说明
```

那句边界说明是：**只能影响生成内容的取值，不得改变 JSON 的形状与字段。**

结构化输出有 schema 校验，记忆如果影响了 JSON 形状，那是直接的结构化失败，
不是「回答得不好」。所以边界必须写死在 prompt 里。

**抽取**：只取**最后一条用户消息**，且**不带最终回答**。
生成的表格 / JSON 是数据——拿它去抽取等于让模型把自己的输出记成用户偏好。

**Mock 分支不注入**：Mock 走 fixture 回放，没有真实 system prompt，
注入进去只是自欺欺人。

---

## 4. 四链路对照表

| 维度 | 普通对话 | multi | plan | rag | structured |
| --- | --- | --- | --- | --- | --- |
| 端点 | `/api/chat` | `/api/chat/multi` | `/api/chat/plan` | `/api/rag/chat` | `/api/chat/structured` |
| 检索次数 | 1 | 1 | 1 | 1 | 1 |
| 检索位置 | `chat.ts` | 路由层（judge 后） | 路由层 | 路由层（judge 后） | 路由层 |
| 注入形态 | 独立 system 消息 | 独立 system 消息 | 追加小节 ×3 | 追加小节 | 追加小节 |
| 注入位置 | 对话之前 | worker system | planner / step / 终答 / re-plan | 「## 资料」之后 | system prompt 末尾 |
| 检索问题 | 用户当前问题 | 用户当前问题 | 用户当前问题 | 用户当前问题 | 最后一条用户消息 |
| 抽取时机 | 回复完成后 | aggregate 之后 | 最终回答之后 | 回答之后 | `structured_done` 之后 |
| 抽取输入 | 最近 N 轮 + 回复 | 最近 2 轮用户消息 + aggregate 回复 | 最近 2 轮用户消息 + 终答 | 最近 2 轮用户消息 + 终答 | **仅最后一条用户消息** |
| 带最终回答 | 是 | 是 | 是 | 是 | **否** |
| 检索片段入抽取器 | 否 | 否 | 否 | **否** | 否 |
| 记忆进引用编号 | — | — | — | **否**（明确禁止） | — |
| 记忆影响 JSON 形状 | — | — | — | — | **否**（prompt 边界约束） |

---

## 5. 失败边界

| 场景 | 预期行为 |
| --- | --- |
| 检索失败（向量服务不可用） | 本轮不注入，发 `memory_failed(stage=retrieve)`，回复照常 |
| 抽取失败（模型超时 / 非法 JSON） | 本轮不存，发 `memory_failed(stage=extract)`，回复照常 |
| 落盘失败 | 发 `memory_failed(stage=store)`，回复照常 |
| 用户关闭开关 | 五条链路一律零检索、零抽取 |
| `userId` 非法（不匹配 `anon_*`） | 服务端按「无记忆」处理，不报错 |
| 记忆块过长 | 沿用 Top-5 上限 + 200 token / 10% 预算裁剪 |
| RAG 检索片段含敏感信息 | 与现状一致，由检索侧负责；记忆块不参与 evidence |
| structured 的记忆内容含非法 JSON 字符 | 记忆块不进 JSON 输出路径，只进 system prompt |

---

## 6. 隐私口径（五条链路共同遵守）

这三条不是附加项，是约束：

1. **记忆只进 system prompt / 用户事实小节**，永远不进「引用来源」「资料编号」体系。
2. **抽取输入里永远排除**检索片段、工具返回、结构化输出内容。
3. **记忆内容不写进日志正文**——只记 id、条数、token 估算，与现有 trace 口径一致。

阶段 8 定的两道敏感信息闸（送模型前脱敏、模型输出后拦一次）在这一阶段没有改动，
四条链路复用同一套。

---

## 7. 前端契约

### 7.1 请求侧

四条链路统一：

```ts
...(allowMemory && userId ? { userId, allowMemory: true } : { allowMemory: false })
```

### 7.2 事件侧

三种记忆事件，五条链路形状完全一致：

| 事件 | 时机 | 字段 |
| --- | --- | --- |
| `memory_injected` | 检索命中并完成预算裁剪后 | `itemIds` · `tokens` · `items`（id / key / value / similarity） |
| `memory_extracted` | 抽取与落盘完成后 | `candidates` · `stored` |
| `memory_failed` | 记忆链路某一步失败时 | `stage`（`retrieve` / `extract` / `store`）· `message` |

前端统一由 `api/memoryTrace.ts` 的 `parseMemoryTraceStep()` 解析，
脏数据一律降级（缺字段补默认值）而不是让流崩掉。

### 7.3 面板文案

`components/MemoryPanel.vue` 的提示改成三态，**并带上当前链路名**：

| 状态 | 文案 |
| --- | --- |
| 开关关闭 | 长期记忆已关闭：不会向模型注入记忆，也不会抽取新的偏好 |
| 当前链路未接入 | 当前链路（{链路名}）本阶段尚未接入记忆注入：这一轮既不会把记忆放进上下文，也不会从对话里抽取新事实 |
| 当前链路已接入 | 当前链路（{链路名}）已接入长期记忆：命中的记忆会注入本轮上下文，对话里的明确偏好会在这一轮结束后被记住 |

目前**只有反思复盘（`/api/chat/reflection`）**处于第二种状态。

### 7.4 RAG 侧栏的一个坑

RAG 模式下侧栏原本被「命中面板」独占，`ToolTracePanel` 整块隐藏。
如果照原样，资料问答链路注入了什么记忆用户在界面上**完全看不见**——
这等于「接了但看不见」，比没接还糟。

现在的做法：RAG 模式只渲染**记忆相关**的步骤，其它链路渲染全量；
并且侧栏在「RAG 模式且有记忆事件」时也展开。

---

## 8. 实测情况

**必须先说清楚这一段的边界**：

| 项 | 状态 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm run build` | ❌ **未运行**（用户要求只跑 typecheck） |
| `npm run test:chains` | ❌ **未运行**（用户要求跳过实测以省资源） |
| `npm run test:memory` | ❌ 未在本阶段运行 |
| 单元测试 | ❌ 未写（归后续阶段） |

所以下面两条是**代码层面的保证**，不是实测结论：

- 四条链路的检索次数都是 1（代码路径唯一，D3 可核对）；
- 关闭开关时前端不带 `userId`，服务端零检索零抽取（代码路径唯一，可核对）。

而这几条**需要实测才能下结论**：

- 四条链路在界面上都能看到「注入了 N 条记忆」；
- 关闭开关后四条链路确实零注入零抽取；
- structured 的记忆内容不会改变 JSON 形状；
- RAG 的记忆不会被当成资料编号。

补跑方式：

```bash
LLM_MODEL=deepseek-v4.1-flash npm run test:chains
```

（`.env` 里原配的 `deepseek-v4-flash` 在网关上当时无可用通道，会 503。）
plan 链路还需要 `PLAN_TIMEOUT_MS=600000`。

---

## 9. 已知缺口

| 缺口 | 说明 |
| --- | --- |
| 四条链路未实测 | 见 §8；代码写完了但没跑过真实模型 |
| 端到端跨会话脚本未写 | `scripts/test-memory-chains.ts` 还没建（归指令 7） |
| structured「列名被当成事实」只埋了观察点 | 抽取器共享组件没改；structured 用例里故意把记忆内容设成「表格列名」，但这一项按计划只记录不判负 |
| reflection 未接入 | 反思复盘链路没接记忆，面板如实标注为「未接入」 |
| 记忆不进引用编号体系靠 prompt 约束 | 不是代码级硬隔离；RAG 链路目前靠记忆块文案 + prompt 边界双重提醒 |

---

## 10. 怎么复跑

| 命令 | 覆盖什么 |
| --- | --- |
| `npm run typecheck` | 前端 + 服务端类型（唯一必跑） |
| `npm run test:chains` | 五链路 + 记忆接口回归（含四条链路新增的 `memory_injected` 断言） |
| `npm run test:memory` | 单 Agent 跨会话 + 语义 spike + 并发/损坏 |
| `npm run test:memory-chains` | 四条链路的跨会话命中 / 删除即时失效 / 关闭即时生效（**脚本还没建**） |
| `npx tsx scripts/check-memory-recall.ts` | 检索阈值标定 |

---

## 11. 相关文件

路径为工作区两级相对路径（`memory/` 指服务端记忆目录，`routes/` 指服务端路由目录，
`api/`、`components/`、`composables/` 指前端对应目录）。

**新增**：

- `memory/bridge.ts` — 公共接入层：检索 / 抽取编排 / 抽取输入裁剪 / 事件构造
- `memory/index.ts` — 记忆模块统一出口
- `multi-agent/workers/memoryPrompt.ts` — Worker 记忆拼装
- `api/memoryTrace.ts` — 前端记忆事件统一解析

**修改（服务端）**：

- `chat.ts` — `memoryBlock` 落地为「提供方已处理」语义
- `memory/context.ts` — `MEMORY_SECTION_TITLE` · `renderMemorySection()`
- `multi-agent/graph.ts` — `memoryBlock` 下发给 worker
- `multi-agent/workers/types.ts` — `WorkerContext.memoryBlock`
- `multi-agent/workers/{general,kb,action,realtime}Worker.ts` — 走公共拼装
- `plan-execute/prompts.ts` — 三处 prompt 加记忆小节 + 使用边界
- `plan-execute/{planner,executor,finalReply,replan}.ts` — context 透传
- `plan-execute/graph.ts` — 全图下传
- `rag/prompt.ts` — 「## 资料」之后追加记忆小节
- `rag/answer.ts` — `answerFromDocs` 第 7 参扩成 options
- `structured/complete.ts` — `buildSystemPrompt(target, memoryBlock)`
- `structured/types.ts` — schema 加可选 `userId` / `allowMemory`
- `routes/{chatMulti,chatPlan,ragChat,chatStructured}.ts` — 检索一次 + 发事件 + 下传 + 抽取
- `memory/README.md` · `multi-agent/README.md` · `plan-execute/README.md` ·
  `rag/README.md` · `structured/README.md` — 模块说明同步

**修改（前端）**：

- `api/chat.ts` — `streamPlan` / `streamStructured` 加 `userId` / `allowMemory`；统一事件解析
- `api/rag.ts` — `askRag` 加 `userId` / `allowMemory`；统一事件解析
- `composables/useChat.ts` — 四条链路统一传参
- `types.ts` — `ToolTraceStep` 补 `memory_failed`
- `App.vue` — 链路标签 · 记忆事件过滤 · RAG 侧栏接线
- `components/MemoryPanel.vue` — 三态提示 + 链路名
- `components/ToolTracePanel.vue` — `memory_failed` 分支

**修改（脚本与文档）**：

- `scripts/test-chat-chains.ts` — 四条链路各加三段记忆断言
- `docs/flows-index.html` · `docs/flows-index.md` — 索引页同步
- `docs/project-topology.html` — 拓扑页同步

---

## 12. 配套文档

- [memory.md](./memory.md) — 阶段 8：跨会话记忆的原始设计与实测
- [memory-changelog.md](./memory-changelog.md) — 阶段 8 变更记录
- [memory-chain-changelog.md](./memory-chain-changelog.md) — 阶段 9 变更记录
- [memory-chain-flow.svg](./memory-chain-flow.svg) — 阶段 9 流程图
- [project-topology.html §6i](./project-topology.html#memory-chain) — 方法级拓扑
- [flows-index.html](./flows-index.html) — 流程图索引
- `tasks/memory-chain-integration-plan.md` — 计划与逐条执行记录
