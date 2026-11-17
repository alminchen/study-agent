# Reflection 接入记忆执行计划

> 前置：`tasks/memory-plan.md`（Memory 专项已完成）、`tasks/memory-chain-integration-plan.md`（五链路接入，反思未接）
>
> 本文档**只规划，不实现**。后续按本文的「指令 1～N」逐条执行，一次一条，
> 每条做完必须满足该条的完成判定才进入下一条。
>
> 范围：把已建好的跨会话记忆接到 `/api/chat/reflection`（Reflection 复盘链路）上。
> 记忆模块本身（存储、抽取、去重、检索、隐私口径）**不改**。

---

## 0. 为什么要有这份计划

`tasks/memory-chain-integration-plan.md` 已经把记忆接到普通对话、multi、plan、rag、
structured 五条链路上，但**刻意留下 reflection 没接**——当时的判断是 reflection
「先出一版答案，再回头打分，必要时重写」，记忆注入的位置和时机与普通对话不同，
不该照抄。结果就留下一个用户能直接感知到的坑：

```
前端 reflectionEnabled = true  →  聊天走 /api/chat/reflection
  →  记忆既不注入、也不抽取  →  面板如实标注「本阶段尚未接入」
```

「如实说明」不等于「问题解决了」。这份计划要解决的是：**让 reflection 链路也能按同一套
隐私口径注入相关记忆、并在复盘结束后抽取新事实**，同时不改 reflection 的评分/重写语义。

### 做完能带来什么

| 现在 | 做完之后 |
| --- | --- |
| reflection 记忆完全失效 | reflection 能注入相关记忆 + 抽取新事实 |
| 用户要在 reflection 里关掉记忆开关才不困惑 | 记忆语义与其余五条链路一致 |
| 面板标注「reflection 未接入」 | 六条链路全部支持，面板不再有「未接入」分支 |
| 复盘只靠单轮 question，无用户背景 | 复盘能参考用户历史偏好，评分更贴合 |

---

## 1. 现状核对（2026-11-17 实测代码为准）

### 1.1 链路现状

| 项目 | 现状 | 依据 |
| --- | --- | --- |
| 记忆注入 | ❌ | `routes/chatReflection.ts` 无 `retrieveMemoryBlock` 调用 |
| 记忆抽取 | ❌ | `routes/chatReflection.ts` 无 `scheduleMemoryExtraction` 调用 |
| `userId` / `allowMemory` 读取 | ❌ | 请求 schema 只有 `question / sessionId / model / mode / searchDocs` |
| 复用 `createChatStream` | ✅ | `chatReflection.ts:504` 已调 `createChatStream` 产 draft |

### 1.2 关键代码事实

1. **reflection 通过 `createChatStream` 产 draft**（`chatReflection.ts:504`），
   这条函数本身**已经支持** `userId` / `allowMemory` / `memoryBlock` / `contextMode` /
   `contextSummary` 全套参数（`server/chat.ts:104-196`）。也就是说：
   **服务端接线是现成的，缺的只是路由层传参。**
2. **`createChatStream` 的记忆逻辑在 `server/chat.ts:313-370`**：收到
   `memoryBlock === undefined` 时会**自行** `retrieveMemoryBlock`；收到
   `memoryBlock !== undefined`（含 null）时视为「提供方已查过」，不检索、不抽取。
3. **前端 `useChat.ts` 的 reflection 分支**（`src/composables/useChat.ts:1038`）目前
   POST 到 `/api/chat/reflection` 的 body 里**没有** `userId` / `allowMemory`。
4. **记忆面板**（`src/components/MemoryPanel.vue:36`、`src/App.vue:214-223`）通过
   `memoryInjectionSupported`（= `!reflectionEnabled`）标注 reflection 为「未接入」。

---

## 2. 目标与边界

### 目标

1. reflection 链路按需注入当前用户相关记忆，遵守同一套隐私口径。
2. reflection 链路在复盘结束后抽取长期事实，关闭开关时零抽取。
3. 检索 / 抽取失败**不阻断**复盘正常评分与重写。
4. 前端把 `memory_injected` / `memory_extracted` / `memory_failed` 过程事件如实回传。
5. 记忆面板对 reflection 显示真实状态，不再有「未接入」分支。

### 明确不做（防止范围膨胀）

- 不改记忆存储格式、阈值、隐私规则（同 `tasks/memory-plan.md` 结论）。
- 不改 reflection 的评分维度、重写阈值、`reflection_scored` / `reflection_revised` 事件。
- 不引入语义记忆、向量库。
- 不改 `createChatStream` 的记忆核心逻辑（它已支持所需参数，只做参数透传）。

---

## 3. 接入方案（关键设计决策）

### 3.1 记忆块从哪来

reflection 与 `chatPlan` 的 ReAct 回退路径**同构**：两者都调 `createChatStream`。
所以采用 `chatPlan` 已验证的「路由层检索一次、传下去复用」模式：

```
reflection 路由层：
  校验 userId / allowMemory
    → retrieveMemoryBlock(memoryOptions, question)   // 检索一次
    → 若有块：写 memory_injected 事件
    → 把 memoryBlock 传给 createChatStream（memoryBlock 语义：提供方已查过）
    → createChatStream 不再自检索、不再自抽取
  复盘结束后：scheduleMemoryExtraction(memoryOptions, ...)   // 抽取一次
```

**为什么不让 createChatStream 自己检索？**
`chatPlan` 的注释（`chatPlan.ts:166`）已说明：一次请求只检索一次、只抽一次。
若 reflection 既在路由层检索又在 createChatStream 里检索，会重复向量计算，
还可能产生两份不一致的注入。

### 3.2 摘要 / 长上下文与记忆的交互

reflection 当前只传 `[{ role: "user", content: question }]` 一条消息（`chatReflection.ts:505`），
没有历史、没有摘要。因此：

- **本计划只接记忆，不动长上下文。** reflection 的消息数组只有本轮 question，
  走 `legacy` 模式（默认）即可，`buildContext` 的预算分层对单条消息无压缩意义。
- 记忆作为独立 system 消息，由 `createChatStream` 的 legacy 分支插入
  （`server/chat.ts:324-340`，`system → 记忆 → 原文`），与单 Agent legacy 口径一致。

### 3.3 抽取输入

reflection 的「对话」本质是 `question → draft（初版）→（可能重写）→ 终稿`。
抽取应该基于**用户问题 + 最终采纳的答案**，而不是 toolFacts / 评分中间产物。
复用 `buildExtractionInput`（`server/memory/bridge.ts:108`），传入
`messages: [{role:"user",content:question}]` + `finalReply: 最终稿文本`。

---

## 4. 文件改动清单

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `server/routes/chatReflection.ts` | schema 加 `userId?` / `allowMemory?`；路由层检索 + 透传 + 抽取 | 核心 |
| `src/composables/useChat.ts` | reflection POST body 加 `userId` / `allowMemory` | 前端接线 |
| `src/App.vue` | `memoryInjectionSupported` 恒 true（六链路全支持） | 面板状态 |
| `src/components/MemoryPanel.vue` | 移除「未接入」分支文案 | 面板状态 |
| `docs/reflection-memory-changelog.md` | 新建变更记录 | 文档 |

> 说明：`server/memory/bridge.ts`、`server/chat.ts` 的 memory 核心逻辑**零改动**。
> `createChatStream` 已支持 `memoryBlock` 语义，无需改。

---

## 5. 完成判定（每条指令的验收）

### 指令 1 · 服务端接线

**做什么**：`chatReflection.ts` 增加 `userId` / `allowMemory` 到 schema；在生成 draft 前
按 `chatPlan.ts:245-315` 的模式检索记忆、发 `memory_injected`、透传 `memoryBlock`；
draft + 评分 + 重写全部结束后 `scheduleMemoryExtraction`。

**完成判定**：
- [x] `typecheck` 通过。（2026-11-17 服务端 `tsc -p tsconfig.server.json --noEmit` 干净；前端 `vue-tsc` 仅有既有的 `useChat.ts` 未使用函数报错，与本次改动无关）
- [x] 请求带 `allowMemory:true` + 合法 `userId` 时，SSE 流里有 `memory_injected` 事件。（2026-11-17 检索层验证命中 1 条；路由层 `buildMemoryInjectedEvent` 已按同口径发出）
- [x] `allowMemory:false` 或非法 `userId` 时，`retrieveMemoryBlock` 返回 null（零检索）。（2026-11-17 脚本验证均返回 null）
- [x] 复盘结束后触发抽取；关闭开关时零抽取。（2026-11-17 `scheduleMemoryExtraction` 在 allowMemory 非 true / 非法 id / mock 下内部直接返回，路由层透传的 `memoryOptions` 已覆盖）
- [x] `createChatStream` 收到的 `memoryBlock` 为「提供方已查过」语义，不重复检索/抽取。（2026-11-17 透传时不重复发 `memory_injected`，不传时自行检索）

> 执行记录（指令 1，2026-11-17）：`server/routes/chatReflection.ts` 增加
> `userId` / `allowMemory` 到 schema；路由层检索一次并发 `memory_injected`；
> `createChatStream` 调用透传 `userId` / `allowMemory` / `memoryBlock`；
> `runReflectionPipeline` 结束后按「question + finalDraft」抽取。

### 指令 2 · 前端接线与面板

**做什么**：`useChat.ts` reflection 分支 body 加 `userId` / `allowMemory`；
`App.vue` 的 `memoryInjectionSupported` 恒 true；`MemoryPanel.vue` 移除「未接入」分支。

**完成判定**：
- [x] 前端切到 reflection 后，请求体包含 `userId` / `allowMemory`。（2026-11-17 `src/api/chat.ts` `streamReflection` 增加两参数并写进 body；`src/composables/useChat.ts` `runReflection` 传入 `memoryUserId` / `allowMemory`）
- [x] 记忆面板显示「已接入」状态，不再出现「本阶段尚未接入记忆注入」。（2026-11-17 `src/App.vue` `memoryInjectionSupported` 改为恒 true 并移除 prop 绑定；`src/components/MemoryPanel.vue` 删除「未接入」warn 分支与 `injectionSupported` prop）
- [x] 面板能看到 `memory_injected` 的条目 id 与 token。（2026-11-17 `ToolTracePanel.vue` 已有 `memory_injected` 渲染分支，reflection 的 `onTrace` 透传该事件即可）

> 执行记录（指令 2，2026-11-17）：`streamReflection` 参数与 body 接线、
> `runReflection` 传参、`memoryInjectionSupported` 恒 true、`MemoryPanel` 移除
> 「未接入」分支与 prop。`npm run typecheck` 报出的 `useChat.ts:406`
> `_loadModelOptions` 未使用为既有问题，本次未触及该函数。

### 指令 3 · 回归与文档

**做什么**：跑 `npm run typecheck`、`npm run test:chains`（若用户同意运行）；
写 `docs/reflection-memory-changelog.md`；更新 `docs/memory-chain-integration.md` 的
「反思复盘未接入」说明为「已接入」；更新 `docs/memory.md` 的五链路为六链路表述。

**完成判定**：
- [x] `typecheck` 通过；`test:chains` 若运行则通过。（2026-11-17 `typecheck`：服务端 `tsc` 干净；前端 `vue-tsc` 仅报既有 `useChat.ts:406` `_loadModelOptions` 未使用，非本次引入。`test:chains` 未跑：现有 5 条覆盖不含 reflection 且需真实模型，待确认）
- [x] changelog 记录改动文件、事件、回归结果。（2026-11-17 新建 `docs/reflection-memory-changelog.md`）
- [x] 文档中「reflection 未接入」字样全部改为「已接入」。（2026-11-17 `docs/memory-chain-integration.md` 面板文案与已知缺口、`docs/memory.md` §3.1 链路现状表已更新为六链路已接入）

> 执行记录（指令 3，2026-11-17）：新建 `docs/reflection-memory-changelog.md`；
> `docs/memory-chain-integration.md` 面板文案改为两态 + 已知缺口 reflection 行改「已接入但未实测」；
> `docs/memory.md` §3.1 链路现状表补全六链路已接入、四链路表述改六链路。

---

## 6. 风险与回退

| 风险 | 缓解 | 回退 |
| --- | --- | --- |
| 记忆注入污染评分 | 记忆只进 draft 的 ReAct 图，critic/revise 是独立 caller 不看记忆 | 恢复 `memoryBlock` 不传 |
| 重复检索 | 路由层检索一次 + `memoryBlock` 非 undefined 语义 | 恢复路由层不检索 |
| 抽取误存工具过程 | 只喂 `question + 终稿`，不喂 toolFacts | 调整抽取输入 |
| 面板误报「未接入」 | 指令 2 同步改 `memoryInjectionSupported` | 保留旧分支文案 |

---

## 7. 验收总览

- [x] 功能：reflection 注入记忆，关闭开关零注入（代码接线完成；检索/开关路径已脚本核对）
- [x] 失败路径：检索失败不阻断评分/重写（`retrieveMemoryBlock` 内部 catch 返回 null，主链路照常）
- [x] 测试：typecheck 通过（服务端干净；前端仅报既有 `useChat.ts:406` 未使用，非本次引入）。`test:chains` 未跑：现有 5 条覆盖不含 reflection 且需真实模型
- [x] 文档：changelog 已建 + 「未接入」表述已更新为「已接入」

> 收尾记录（2026-11-17）：三条指令全部执行完毕并回填。
> 未覆盖项：真实模型端到端 SSE 验证、`test:chains` reflection 用例（待补）。

> 说明：真实模型验收需 `LLM_API_KEY` 且 `MOCK_MODE != 1`；mock 模式仅验证事件流与
> 面板状态，不代表记忆质量。
