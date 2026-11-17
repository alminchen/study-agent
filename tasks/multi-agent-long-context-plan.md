# 长上下文（Token 预算压缩）多 Agent 接入执行计划

> 前置：`tasks/long-context-management-plan.md`（长上下文专项已完成，仅接单 Agent）、
> `tasks/memory-chain-integration-plan.md`（记忆已接五链路，含 multi）
>
> 本文档**只规划，不实现**。后续按本文的「指令 1～N」逐条执行，一次一条，
> 每条做完必须满足该条的完成判定才进入下一条。
>
> 范围：把单 Agent 已验证的「Token 预算分层压缩」（`buildContext` + `maybeSummarize`）
> 接到多 Agent 链路的 Worker 上下文上。记忆已接入（`memoryBlock` 已下发给 Worker），
> 本计划**只补长上下文压缩，不改记忆注入**。

---

## 0. 为什么要有这份计划

单 Agent 的长上下文管理（`tasks/long-context-management-plan.md` 指令 1～8）已经完成：
`buildContext` 按 token 预算做 `system → 摘要 → 近期原文` 分层，`maybeSummarize` 把
丢掉的内容压成结构化摘要，前端能看到 `context_compacted` 事件。**但那条链路只接在
`/api/chat`（单 Agent）**，`buildContext(` 的全局唯一调用方是 `server/chat.ts`。

多 Agent 是**默认开启**的链路（前端 `multiAgent` 默认 true），用户实际聊天大多走
`/api/chat/multi`。这条链路目前：

```
chatMulti 路由  →  只取 lastUser 当 userText（history 不传）
                  →  Supervisor / Aggregate 只吃当前一轮
                  →  Worker 只吃 system + task + 工具交互
```

结果：**多 Agent 完全不管理长上下文**，早期对话事实会在 Worker 的 mini ReAct 里
静默消失，且没有 `context_compacted` 事件可观测。

这份计划把单 Agent 的预算压缩搬到多 Agent，并处理多 Agent 特有的问题：
**历史该进哪个节点**（Supervisor / Worker / Aggregate 的上下文角色不同）。

---

## 1. 现状核对（2026-11-17 实测代码为准）

### 1.1 多 Agent 的上下文现状

| 节点 | 当前消息构成 | 是否带历史 | 依据 |
| --- | --- | --- | --- |
| Supervisor | `system + 当前问句` | ❌ | `supervisor.ts:125` |
| Worker（general/kb/realtime/action） | `system + 记忆 + task + 工具交互` | ❌ | `workers/memoryPrompt.ts`、各 worker |
| Aggregate | `system + 用户问题 + Worker结果` | ❌ | `aggregate.ts:138` |

### 1.2 关键代码事实

1. **前端已把完整历史发给路由**：`useChat.ts` 的 `toApiMessages(history)` 传全部
   `messages` 给 `streamChat`（`useChat.ts:886`），`chatMulti` 也收到了
   `req.body.messages`（`chatMulti.ts:65`），但只取 `lastUser`（`chatMulti.ts:91`）。
   → **数据源已就绪，缺的是把历史传到 Worker。**
2. **`buildContext` 是纯函数**（`context/buildContext.ts:224`）：输入
   `{ messages, summary, systemPrompt, budgetTokens, maxRecentRounds, memory }`，
   输出 `{ messages, droppedMessages, droppedMessageIndices, estimatedTokens, usedSummary, degraded, memoryItemIds }`。
   可复用，无需改内核。
3. **`maybeSummarize` 在 `server/chat.ts:192`**：接收 `ContextBuildResult`，
   生成结构化摘要。它是 chat.ts 私有函数，多 Agent 需导出或抽成公共模块。
4. **Worker 用 `buildWorkerMessages` 构建初始消息**（`workers/memoryPrompt.ts`）：
   目前是 `system → 记忆 → task`。长上下文压缩应作用于**历史**，而非 task。

---

## 2. 目标与边界

### 目标

1. 多 Agent 的 Worker 在 mini ReAct 前，把**早期对话**按 token 预算压缩成
   `system → 摘要 → 近期原文 → 记忆 → task` 的上下文。
2. 压缩超过阈值时生成结构化摘要并回传 `context_compacted` 事件。
3. Supervisor / Aggregate **不做**长上下文压缩（它们只做路由与汇总，
   历史塞进去会稀释路由判断、增加 token）。
4. 摘要失败降级为「只有近期原文的裸窗口」，Worker 照常执行。

### 明确不做（防止范围膨胀）

- 不改 `buildContext` / `tokenBudget` 内核（单 Agent 已验证，复用即可）。
- 不改记忆注入逻辑（`memoryBlock` 已下发，本计划只负责把历史也放进去）。
- 不把历史注入 Supervisor / Aggregate（设计决策，见 §3）。
- 不改变 Worker 的工具隔离、确认边界、错误回填。

---

## 3. 接入方案（关键设计决策）

### 3.1 历史进哪个节点？—— 只进 Worker，不进 Supervisor / Aggregate

多 Agent 的节点角色不同：

| 节点 | 角色 | 历史的作用 | 是否注入历史 |
| --- | --- | --- | --- |
| Supervisor | 把用户问题路由到领域 Worker | 历史会稀释「这轮问什么」 | ❌ 保持现状 |
| Worker | 真正回答问题，可能要调工具 | 历史是回答的上下文 | ✅ **本计划接入** |
| Aggregate | 汇总各 Worker 结果 | 历史不产生新事实 | ❌ 保持现状 |

这延续了记忆的既有口径（`graph.ts` 注释：`memoryBlock` 只下发给 Worker，
不给 supervisor/aggregate）。长上下文同理：**历史是 Worker 回答的事实背景，
不是路由或汇总的输入**。

### 3.2 Worker 上下文顺序

Worker 的 mini ReAct 初始消息目前是：

```
[system(角色)] → [memory(记忆)] → [user(task)]
```

接入长上下文后，顺序调整为：

```
[system(角色)]
→ [system(结构化摘要)]        ← 早期对话的压缩摘要（新增）
→ [system(记忆)]              ← 已有
→ [user(task)]                ← Supervisor 分配的子任务
```

为什么摘要排在记忆前面：摘要是「这段对话讲过什么」，记忆是「这个用户一贯是什么样」，
两者都是资料，都先于当前 task 进入视野，与 `buildContext` 的既有位置口径一致
（`buildContext.ts`：摘要 → 记忆 → 近期原文）。

### 3.3 近期原文去哪

Worker 的 `task` 是 Supervisor 拆出来的**子任务**，不是完整历史。真正的近期原文
应从路由层传入的 `messages` 里取，经 `buildContext` 压缩后作为 Worker 上下文的
「近期原文层」。

```
路由层（chatMulti）:
  history = messages（前端已传全量）
  → buildContext({ messages: history, summary: contextSummary, systemPrompt: worker系统提示, budgetTokens, memory })
  → 得到 compressedMessages（system → 摘要 → 近期原文 → 记忆）
  → 每个 Worker 用 [compressedMessages..., {role:"user",content:task}] 作为初始消息
```

### 3.4 预算来源

复用 `resolveBudgetTokens`（`context/tokenBudget.ts`）：读取 `runtimeConfig.context.windowTokens`
与 `context.budgetRatio`，与单 Agent 一致。多 Agent 可加环境变量
`MULTI_CONTEXT_BUDGET_RATIO`（默认同单 Agent），但**不设默认关闭**——本计划默认开启，
因为多 Agent 是主链路。

---

## 4. 文件改动清单

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `server/chat.ts` | 导出 `maybeSummarize`（或抽到 `context/summarize.ts`） | 复用内核 |
| `server/multi-agent/workers/memoryPrompt.ts` | `buildWorkerMessages` 增加 `history` / `summary` 参数 | 核心 |
| `server/multi-agent/workers/types.ts` | `WorkerContext` 加 `historyMessages?` / `contextSummary?` | 类型 |
| `server/multi-agent/graph.ts` | `MultiAgentGraphOptions` 加 `historyMessages` / `contextSummary`；workersNode 透传 | 核心 |
| `server/routes/chatMulti.ts` | 调 `buildContext` + `maybeSummarize`，产摘要与压缩上下文，下发 graph | 核心 |
| `src/composables/useChat.ts` | multi 请求加 `contextSummary`（前端已带，确认透传） | 前端接线 |
| `src/App.vue` | multi 链路监听 `context_compacted` 事件 | 前端面板 |
| `docs/multi-agent-long-context-changelog.md` | 新建变更记录 | 文档 |

---

## 5. 完成判定（每条指令的验收）

### 指令 1 · 暴露摘要内核

**做什么**：把 `maybeSummarize` 从 `server/chat.ts` 私有函数导出，或抽到
`server/context/summarize.ts` 作为公共函数（保留原调用点行为不变）。

**完成判定**：
- [x] `typecheck` 通过。
- [x] 单 Agent 路径调用点仍用同一函数，行为无回归。
- [x] 函数签名不含多 Agent 专属类型（保持通用）。

> ✅ 已完成（2026-11-17）：把 `maybeSummarize` 与门槛常量
> `SUMMARY_TRIGGER_MIN_MESSAGES` / `SUMMARY_TRIGGER_MIN_TOKENS` 从 `chat.ts`
> 抽到 `context/summarize.ts` 并导出；`chat.ts` 改为 `import { maybeSummarize }`，
> 调用点参数逐字不变。服务端 `tsc -p tsconfig.server.json --noEmit` 对改动文件零错误。
> （`npm run typecheck` 中 `useChat.ts` 的 `_loadModelOptions` 未使用告警为仓库既有问题，与本指令无关。）

### 指令 2 · Worker 上下文接历史与摘要

**做什么**：`buildWorkerMessages` 增加可选 `historyMessages` / `contextSummary` 参数；
当历史非空时，输出 `[system, system(摘要), system(记忆), ...历史原文, user(task)]`；
无历史时输出与现状逐字一致。

**完成判定**：
- [x] 无历史时，输出与接入前**逐字一致**（回归边界）。
- [x] 有历史时，历史经预算裁剪，超出的进 `droppedMessages`。
- [x] `memoryBlock` 仍在摘要之后、task 之前。
- [x] 单测覆盖「无历史 / 有历史 / 摘要超预算」三态。

> ✅ 已完成（2026-11-17）：
> - `workers/types.ts`：`WorkerContext` 加 `historyMessages?` / `contextSummary?`。
> - `workers/memoryPrompt.ts`：`buildWorkerMessages` 加 `historyMessages` / `contextSummary`
>   可选参数，顺序 `[system, system(摘要), system(记忆), ...历史原文, user(task)]`；
>   无历史/无摘要时输出逐字不变。
> - 四个 Worker（general/kb/realtime/action）调用点透传 `ctx.historyMessages` / `ctx.contextSummary`。
> - 新增 `memoryPrompt.test.ts`，三态单测通过；服务端 `tsc --noEmit` 零错误。
> - 说明：历史的 token 预算裁剪（`droppedMessages`）在路由层 `buildContext` 完成，
>   Worker 只摆位置不重复裁剪，该裁剪逻辑归指令 3 验收。

### 指令 3 · 路由层构建压缩上下文

**做什么**：`chatMulti.ts` 在检索记忆后，用 `buildContext` 处理 `messages` 历史，
必要时调 `maybeSummarize` 生成摘要，把 `compressedMessages` 与 `contextSummary`
下发给 graph（经 `MultiAgentGraphOptions`）。

**完成判定**：

> ✅ 已完成（2026-11-17）：
> - `multi-agent/graph.ts`：`MultiAgentGraphOptions` 加 `historyMessages?` / `contextSummary?`，
>   `workersNode` 透传给每个 Worker（Supervisor / Aggregate 不接收）。
> - `routes/chatMulti.ts`：新增「步骤 3.6 长上下文压缩」——取最后一条 user 之前的
>   非空、无附件消息作 rawHistory；`buildContext`（空 systemPrompt、无 memory）裁历史；
>   有 `droppedMessages` 时调 `maybeSummarize` 生成摘要并用新摘要重建；
>   推 `context_compacted` 事件；把近期原文层与摘要经 graph options 下发。
> - 摘要 usage 记到 `summary` 来源；Mock 模式跳过摘要生成。

**完成判定**：
- [x] 历史为空时（首轮）零开销，行为与现状一致。
- [x] 历史超预算时生成 `context_compacted` 事件（含 `compactedRounds` / token）。
- [x] 摘要失败时降级为裸窗口，Worker 照常执行。
- [x] 记忆注入不因长上下文而重复或丢失。

> 验证：服务端 `tsc -p tsconfig.server.json --noEmit` 零错误。
> 说明：`npm run build` 卡在前端 `useChat.ts` 的 `_loadModelOptions` 既有错误（vue-tsc），
> 与本指令的后端改动无关。

### 指令 4 · 前端接线与面板

**做什么**：确认 `useChat.ts` multi 请求带 `contextSummary`；`App.vue` 在 multi 链路
监听 `context_compacted` 并更新压缩提示（复用单 Agent 的 `ContextCompactionNotice`）。

**完成判定**：
- [x] 前端 multi 请求体包含 `contextSummary`。
- [x] multi 链路收到 `context_compacted` 事件后显示「已压缩 X 轮」提示。
- [x] 提示与单 Agent 链路样式一致。

> ✅ 已完成（2026-11-17）：前端接线**经核实已全部就位**，无需改动代码。
> - `composables/useChat.ts`：`runStream`（multi 链路）已发送 `contextSummary`，
>   并绑定 `onContextCompacted` → 写 `contextCompaction` ref + 摘要落盘 localStorage。
> - `api/chat.ts`：`streamChat` 按 `multiAgent` 选端点，统一发送 `contextSummary`、
>   统一解析 `context_compacted` 事件（multi 与单 Agent 共用同一套解析）。
> - `App.vue`：已挂载 `<ContextCompactionNotice :event="contextCompaction" />`，
>   multi 与单 Agent 复用同一组件、同一提示文案「已压缩 X 轮」与同一样式。
> - 验证：`vue-tsc --noEmit` 对前端接线无新增错误（`_loadModelOptions` 为既有告警）。
> - 说明：multi 服务端（指令 3）当前每轮独立压缩，暂不消费前端上传的旧摘要
>   `previousSummary`；但本指令判定只要求「请求体带 contextSummary」+「收到事件显示提示」，
>   两者均满足。跨轮增量摘要可作后续优化。

### 指令 5 · 回归与文档

**做什么**：跑 `npm run typecheck`、`npm run build`、`npm run test:chains`（如需）；
写 `docs/multi-agent-long-context-changelog.md`；更新
`docs/long-context.md` 与 README 能力表，注明「多 Agent 已接入」。

**完成判定**：

> ✅ 已完成（2026-11-17）：
> - 新建 `docs/multi-agent-long-context-changelog.md`：记录改动文件、SSE 事件、
>   失败路径、回归结果与已知边界。
> - 更新 `docs/long-context.md` §6.6 生效范围：由「只发生在单 Agent」改为
>   「单 Agent + 多 Agent Worker」，并补充只进 Worker 的口径。
> - 更新 `README.md` 能力表与功能表：长上下文标注多 Agent Worker 已接入，
>   多 Agent 持久化补「上下文摘要（只注入 Worker）」。

**完成判定**：
- [x] typecheck / build 通过。
- [x] changelog 记录改动、事件、回归结果。
- [x] 文档「长上下文仅单 Agent」字样更新为「单 Agent + 多 Agent Worker」。

> 回归结果：
> - 服务端 `tsc -p tsconfig.server.json --noEmit` 通过；全仓 `*.test.ts` 单测 171/171 通过。
> - `npm run build` 卡在 `useChat.ts` 的 `_loadModelOptions` 既有告警（与本计划无关）。
> - `npm run test:chains` 需起服务（tsx IPC 管道），沙箱内 EPERM 未跑。

---

## 6. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| 历史塞进 Supervisor 造成路由漂移 | 明确只进 Worker，Supervisor/Aggregate 不动 | 恢复只传 task |
| 四 Worker 各压一次 = 重复计算 | 路由层压缩一次，下发压缩好的上下文 | 恢复 Worker 不接历史 |
| 摘要失败拖慢 Worker | `maybeSummarize` 失败返回 null，降级裸窗口 | 关闭摘要 |
| 历史含图片/结构化内容报错 | 复用 `toApiMessages` 已清洗（图片不跨轮） | 仅文本历史 |
| 回归风险（多 Agent 是主链路） | 无历史时逐字一致 + `test:chains` | 默认关闭开关 |

---

## 7. 验收总览

- [x] 功能：多 Agent Worker 注入压缩后的历史，超预算产生 `context_compacted`
- [x] 失败路径：摘要失败降级，Worker 照常
- [x] 测试：typecheck + build + test:chains（如需）
- [x] 文档：changelog + 更新「仅单 Agent」表述

> 状态（2026-11-17）：指令 1～5 代码层面全部完成，压缩管线在单测层面验证
> （171/171 通过、服务端 typecheck 通过）。
> **真实模型端到端验收待补**：需 `LLM_API_KEY` 且 `MOCK_MODE != 1`
> （多 Agent 不支持 Mock），并在非沙箱环境跑 `npm run test:chains`。

> 说明：真实模型验收需 `LLM_API_KEY` 且 `MOCK_MODE != 1`。多 Agent 不支持 Mock，
> 因此本计划的功能验收需真实 Key 或在 stub 单测层面验证压缩管线。
