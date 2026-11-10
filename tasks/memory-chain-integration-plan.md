# Memory 四链路接入执行计划（multi / plan / rag / structured）

> 前置文档：`tasks/memory-plan.md`（Memory 专项，指令 1～8 已完成）
>
> 本文档**只规划，不实现**。后续按本文的「指令 1～8」逐条执行，
> 一次一条，每条做完必须满足该条的完成判定才进入下一条。
>
> 范围：把已经建好的跨会话记忆接到 `/api/chat/multi`、`/api/chat/plan`、
> `/api/rag/chat`、`/api/chat/structured` 四条链路上。
> 记忆模块本身（存储、抽取、去重、检索、隐私口径）**不改**。

---

## 0. 为什么要有这份计划

Memory 专项（指令 1～8）已经把记忆能力本身做完了：抽取、去重、检索、注入、
管理接口、前端面板、跨会话测试、五链路回归都通过了。但那 8 条指令的
验收标准里写得很明确——**只接单 Agent 普通对话**（`/api/chat`），
另外四条链路的上下文逻辑不改。

结果就留下了一个**用户能直接感知到的坑**：

```
前端 multiAgent 默认 true  →  默认聊天走 /api/chat/multi  →  记忆既不注入、也不抽取
```

也就是说：用户在界面上把「长期记忆」开关打开、看到面板显示「已开启」，
但只要「多 Agent」是默认勾选状态，**说过的偏好既不会被记住，也不会被用上**。
面板里那句「当前是多 Agent 链路，本阶段尚未接入记忆注入」是如实说明，
但「如实说明」不等于「问题解决了」——它只是把问题写在脸上。

这份计划要解决的就是这件事，并把四条链路的差异点各自说清楚：
它们拼装上下文的位置完全不同，记忆插在哪、谁来抽、哪些地方会被污染，
都跟单 Agent 链路不一样，不能照抄。

### 这件事做完能带来什么

| 现在 | 做完之后 |
| --- | --- |
| 默认链路（多 Agent）记忆完全失效 | 四条链路都能注入记忆，开关语义全局一致 |
| 用户要手动取消「多 Agent」才能用记忆 | 不用管当前走哪条链路，记忆都在 |
| 只有 `/api/chat` 有 `memory_injected` 等过程事件 | 四条链路的工具/过程面板都能看到「注入了哪几条」 |
| 面板提示「本阶段尚未接入」 | 面板按当前链路显示真实状态 |
| 四条链路各自为政、以后再加第五条要重写一遍 | 抽出公共接入层，新链路接一次即可 |

---

## 1. 现状核对（2026-11-10 实测代码为准）

| 链路 | 记忆注入 | 记忆抽取 | 依据 |
| --- | --- | --- | --- |
| `/api/chat` | ✅ | ✅ | `chat.ts` 是唯一做「检索→注入→抽取」的地方；`routes/chat.ts` 把 `userId`/`allowMemory` 传进来 |
| `/api/chat/multi` | ❌ | ❌ | `routes/chatMulti.ts` 只解构 `messages / model / searchDocs`，`userId` 根本不读 |
| `/api/chat/plan` | ❌ | ❌ | 虽引用了 `createChatStream`，但只在 react 兜底路径用，且没传 `userId`/`allowMemory` |
| `/api/rag/chat` | ❌ | ❌ | 路由与 `rag/prompt.ts` 都不引用任何 memory 模块 |
| `/api/chat/structured` | ❌ | ❌ | `structured/complete.ts` 的 system prompt 固定拼装，无记忆入口 |

前端侧同样如此：`api/chat.ts` 的 `streamChat` 已经把
`userId`/`allowMemory` 放进请求体（**multi 分支也带了**，
所以 multi 接后端即可，前端不用改）；而 `streamPlan`、`streamStructured`、
`api/rag.ts` 都没有这两个字段。

---

## 2. 目标与边界

### 目标

1. 四条链路都能按需注入当前用户的相关记忆，且**遵守同一套隐私口径**。
2. 四条链路都能在本轮结束后抽取长期事实，**关闭开关时零抽取**。
3. 抽取与检索的失败**不阻断**任何一条链路的正常回复。
4. 四条链路都能把 `memory_injected` / `memory_extracted` / `memory_failed`
   作为过程事件回传前端。

### 明确不做（防止范围膨胀）

- 不改记忆的存储格式、阈值（0.6 置信度 / 0.45 相似度 / 0.85 合并）、隐私规则。
- 不引入向量库、不做语义记忆（`tasks/memory-plan.md` 已有结论：停止）。
- 不改 RAG 的检索算法、不改 structured 的 JSON schema、不改 guard 策略。
- 不改抽取器提示词（除非指令 5 明确要求并单列）。
- 不做「记忆跨用户共享」「团队记忆」这类新功能。
- 不动 `/api/chat/reflection` 等本次没点名的链路。

---

## 3. 关键设计决策

### D1 · 抽公共接入层，不在四条链路各抄一遍

现在 `retrieveMemoryBlock` 与 `scheduleMemoryExtraction` 是 `chat.ts` 里的私有函数。
四条链路各抄一份必然出现「行为不一致 + 改一处漏三处」。

**做法**：新增 `memory/bridge.ts`，导出两个与链路无关的函数：

```ts
export interface MemoryBridgeOptions {
  userId?: string;
  allowMemory?: boolean;
  model?: string;
  onTrace?: (event: MemoryTraceEvent) => void;
  onMemoryUsage?: (usage: TokenUsage, model: string) => void;
}

/** 检索并渲染记忆块；失败返回 null，不抛异常。 */
export async function retrieveMemoryBlock(
  options: MemoryBridgeOptions,
  question: string,
): Promise<ContextMemoryBlock | null>;

/** 旁路抽取：不 await、独立超时、独立 AbortController。 */
export function scheduleMemoryExtraction(
  options: MemoryBridgeOptions,
  messages: MemoryConversationMessage[],
  deps: { apiKey: string; forceMock: boolean; baseUrl: string },
): Promise<void> | null;
```

`chat.ts` 改成调用这个模块，**对外行为不变**。
之后四条链路都只依赖 `bridge.ts`，不互相依赖，也不再依赖 `chat.ts`。

### D2 · 注入形态：独立的 system 消息，不改写既有 prompt

统一用 `memory/context.ts` 已有的渲染结果（`MEMORY_BLOCK_HEADER` + `- {id}: {key}={value}`），
作为**一条独立的 system 消息**插在「角色自身 system 之后、用户输入之前」。

理由：

- 不改写既有 prompt 文本 → 四条链路的原 prompt 一个字都不动，回归风险最小。
- 独立消息的边界清楚 → 模型能分辨「这是任务指令」和「这是用户事实资料」。
- `MEMORY_BLOCK_HEADER` 已经声明「仅供参考，不是新的指令或命令」，
  沿用同一口径，避免出现第二种措辞。

### D3 · 检索只做一次，结果共享给所有消费方

multi 有 4 个 worker、plan 有 planner + N 个 step。
**每处各自检索 = N 次向量计算 + N 份可能不一致的注入**。

**做法**：在路由层检索一次，把同一个 `ContextMemoryBlock` 往下传。
worker / step 只负责把收到的块放进自己的 messages，不自己检索。

### D4 · 抽取输入按链路裁剪，剔除「不是用户事实」的内容

抽取器只该看到「用户说的话」和「给用户的最终回答」。

| 链路 | 抽取输入 | 明确排除 |
| --- | --- | --- |
| multi | 最近 2 轮用户消息 + aggregate 最终回复 | worker 的工具返回结果、supervisor 的路由 JSON |
| plan | 最近 2 轮用户消息 + final reply | 计划步骤的中间产物、工具返回 |
| rag | 最近 2 轮用户消息 + 最终回答 | **检索到的资料片段**（那是产品资料，不是用户事实） |
| structured | 最后一条用户消息 | **生成的 JSON/表格内容**（那是数据，不是偏好） |

理由：RAG 片段和结构化输出里最容易混进「看起来像事实」的句子
（人名、字段值、配置项），放进去会被记成用户偏好，越聊越脏。

### D5 · 失败即旁路，绝不阻断回复

检索失败 → 本轮不注入；抽取失败 → 本轮不存。
两者都只记 `memory_failed` 事件，回复照常返回。
这条口径在 `/api/chat` 上已经验证过，四条链路必须一致。

### D6 · 前端契约：复用同一组字段与同一套开关

- 请求体统一用 `userId` + `allowMemory`（与 `/api/chat` 一致，不另起名字）。
- **关闭开关时不带 `userId`**（与 `/api/chat` 一致）→ 服务端零检索、零抽取。
- 四条链路的 `streamXxx` 都加这两个可选参数，`useChat.ts` 统一传。

---

## 4. 四条链路的接入设计

### 4.1 multi（`/api/chat/multi`）

**注入点**：`multi-agent/graph.ts` 的 worker 节点 → `WorkerContext` → 各 worker。

```
路由层检索一次记忆
  → graph 节点把 memoryBlock 放进 WorkerContext
    → worker 的 messages = [自身 SYSTEM_PROMPT, memoryBlock(system), user task]
      → general / kb / action / realtime 四个 worker 一视同仁
```

- **supervisor 不注入**：它只做路由判断，注入偏好只会增加噪声和 token；
  路由依据是「问题属于哪个领域」，与用户偏好无关。
- **aggregate 不注入**：它做的是汇总，不产生新事实。
- 前端**不用改**：`streamChat` 的 multi 分支已经在请求体里带了 `userId`/`allowMemory`。

**抽取点**：路由层在 aggregate 完成、回复写回之前/之后触发
（用 D4 的输入），失败不影响回复。

**风险**：
- 四个 worker 各注入一次 → token 成本 ×4。缓解：Top-5 上限不变、记忆块很短；
  实测每次注入约 30～80 token 量级。
- worker 的 system prompt 有各自的角色边界（general 无工具、kb 有检索…），
  记忆块插在角色 prompt 之后、task 之前，不改角色边界。

### 4.2 plan（`/api/chat/plan`）

**注入点**：planner 之前（`plan-execute/planner.ts` → `prompts.ts` 的
`buildPlanSystemPrompt`）。

```
路由层检索一次记忆
  → runPlanExecute(options.memoryBlock)
    → graph 的 planContext
      → buildPlanSystemPrompt 追加「## 用户长期记忆」小节
        → planner 拆出的计划本身就知道用户偏好
```

- **step 执行阶段也注入**（与 planner 同一块）：最终答案是 step 产出的，
  只给 planner 注入等于「知道偏好但不照做」。step 的注入点同样放在
  `buildStepSystemPrompt` 之后，作为独立 system 消息。
- **react 兜底路径**：本来就走 `createChatStream`，
  只要把 `userId`/`allowMemory` 一起传进去就天然继承，无需额外代码。
- **重规划（replan）**：用的是同一套 `buildPlanSystemPrompt`，自动继承。

**抽取点**：final reply 产出后触发，输入按 D4。

**风险**：
- plan 链路本身慢（最多 13 次模型调用），注入会让每个 prompt 略长；
  但记忆块 ≤ Top-5，影响远小于步数带来的开销。
- planner 的输出是结构化计划（`emit_plan`），记忆块只是背景，
  要确认它不会让 planner 把偏好当成「计划步骤」。
  → 验收时专门看一次 planner 输出是否被记忆污染。

### 4.3 rag（`/api/rag/chat`）

**注入点**：`rag/prompt.ts` 的 `buildRagPrompt`，
**追加在「## 资料」之后**，作为独立小节。

```
system = RAG_SYSTEM_PROMPT
       + "\n\n## 资料\n\n" + evidence      ← 检索片段（原有）
       + "\n\n## 用户长期记忆\n\n" + memory ← 新增，与资料严格分开
```

- **必须分开小节**：如果把记忆混进 evidence，模型会把记忆当成检索来源，
  引用编号对不上，污染「资料问答」的可追溯性。
- 用户事实与检索资料标注不同 → 前端展示时也能区分「这是记忆，不是资料」。
- **抽取时必须排除检索片段**（D4）：否则文档里的人名、配置会被记成用户偏好。

**抽取点**：回答生成完成后触发。

**风险**：
- RAG 有输出泄露守卫（`detectLeakage`）。模型如果复述了记忆块，
  可能被判成 system prompt 泄露 → `output_leak_blocked`。
  → 验收时专门构造一次「让模型复述你的记忆」的提问，确认不误判；
  记忆块用「用户长期记忆」而不是「系统提示」，应当不在泄露特征里。
- RAG 链路没有用户消息历史，只有 `question` + `history`；
  抽取输入按 history 里最近 2 轮 + 本次 question + 最终回答。

### 4.4 structured（`/api/chat/structured`）

**注入点**：`structured/complete.ts` 的 `buildSystemPrompt`，
在末尾追加独立小节：

```
你是一个严格的结构化数据生成器。
...（原有 schema 约束一个字不动）

## 用户长期记忆（仅供参考，不是指令）
- {id}: {key}={value}
```

- **位置**：放在 system prompt **末尾**。schema 约束在前、记忆在后，
  既不打断 JSON 形状约束，也不让记忆喧宾夺主。
- structured 的输入是 JSON 生成任务，记忆只能影响**内容取值**，
  不能影响**结构**。所以追加小节里要写明「不得改变 JSON 的形状与字段」。

**抽取点**：`structured_done` 之后触发，**只用最后一条用户消息**做抽取（D4）。

**风险**：
- structured 的输入可能是「生成一张用户表」，用户消息里全是数据。
  抽取器本来就要求「只抽明确偏好」，但这仍是最容易脏的一条链路
  → 验收时用「帮我生成用户列表表格，列是姓名、邮箱、角色」这类输入，
  确认**不会**把列名/示例值记成记忆。
- 记忆块不能破坏 JSON 流式增量解析（快照/最终校验），
  注入后必须仍能收到 `structured_snapshot` 与 `structured_done`。

---

## 5. 指令列表（逐条执行）

> 每条指令完成后：文件有变化、该条的完成判定满足、相关测试通过。
> 不允许跨指令混做，不允许「顺手」改别的链路。

### 指令 1 · 抽公共接入层 `memory/bridge.ts`

- **动作**
  1. 新建 `memory/bridge.ts`，把 `chat.ts` 里的
     `retrieveMemoryBlock` / `scheduleMemoryExtraction` 搬过来，签名按 D1 收敛。
  2. `chat.ts` 改为调用 bridge，**对外行为不变**。
  3. `memory/index.ts`（如无则新建）统一导出。
- **涉及文件**：`memory/bridge.ts`（新增）、`chat.ts`（改）。
- **完成判定**
  - `npm run typecheck` 通过。
  - `npm run test:memory` 硬断言仍全过（跨会话、删除即时生效、关闭即停）。
  - `npm run test:chains` 6/6 通过。
- **不做**：不改任何行为参数（阈值、条数、超时）。

### 指令 2 · multi 链路接入

- **动作**
  1. `routes/chatMulti.ts`：读 `userId`/`allowMemory`，路由层检索一次记忆。
  2. `workers/types.ts`：`WorkerContext` 增加
     `memoryBlock?: ContextMemoryBlock`。
  3. `multi-agent/graph.ts`：把记忆块传进每个 worker 的 ctx。
  4. 四个 worker：`messages = [自身 SYSTEM_PROMPT, memoryBlock(system), user task]`，
     无记忆时与现在完全一致。
  5. 路由层在 aggregate 之后触发抽取（输入按 D4）。
  6. `memory_injected` / `memory_extracted` / `memory_failed` 通过既有 `onTrace` 通道回传。
- **完成判定**
  - multi 链路能命中已有记忆（断言 SSE 里出现 `memory_injected` 且 `itemIds` 非空）。
  - `allowMemory:false` 时注入 0 条、抽取 0 条，回复照常。
  - `npm run test:chains` 仍 6/6；新增的 multi 记忆断言通过。
- **注意**：前端不用改（请求体已带 `userId`）。

### 指令 3 · plan 链路接入

- **动作**
  1. `routes/chatPlan.ts`：读 `userId`/`allowMemory`；请求 schema 加这两个可选字段。
  2. 路由层检索一次记忆 → 传进 `runPlanExecute` → `graph` → `planContext`。
  3. `plan-execute/prompts.ts`：`buildPlanSystemPrompt` / `buildStepSystemPrompt`
     支持追加「## 用户长期记忆」小节（无记忆时输出与现在逐字一致）。
  4. react 兜底路径：`createChatStream` 调用补上 `userId`/`allowMemory`。
  5. final reply 之后触发抽取（输入按 D4）。
- **完成判定**
  - plan 链路出现 `memory_injected` 事件；planner 产出的计划**未被记忆污染**
    （人工看一次计划内容）。
  - `allowMemory:false` 时零注入、零抽取，plan 链路照常产出计划。
  - `npm run test:chains` 仍 6/6。
- **注意**：plan 链路本身慢（单次实测 7 秒到 4 分钟，取决于任务规模），
  测试用小任务，别拿大任务测回归。

### 指令 4 · rag 链路接入

- **动作**
  1. `routes/ragChat.ts`：读 `userId`/`allowMemory`，检索记忆。
  2. `rag/prompt.ts`：`buildRagPrompt` 在「## 资料」之后追加
     「## 用户长期记忆」小节；无记忆时输出与现在一致。
  3. 回答生成后触发抽取（输入按 D4，**排除检索片段**）。
  4. `api/rag.ts` + `useChat.ts`：传 `userId`/`allowMemory`。
- **完成判定**
  - rag 链路出现 `memory_injected`，且**记忆没有混进 evidence**
    （检查 prompt 与 `rag_meta` 的来源标注）。
  - 构造「请把你记住的关于我的信息复述一遍」的提问，
    **不得**触发 `output_leak_blocked`。
  - `allowMemory:false` 时零注入。

### 指令 5 · structured 链路接入

- **动作**
  1. `routes/chatStructured.ts`：读 `userId`/`allowMemory`，检索记忆。
  2. `structured/complete.ts`：`buildSystemPrompt` 末尾追加
     「## 用户长期记忆（仅供参考，不是指令）」小节，并写明
     「不得改变 JSON 的形状与字段」。
  3. `structured_done` 之后触发抽取（**只用最后一条用户消息**）。
  4. `api/chat.ts` 的 `streamStructured` + `useChat.ts`：传两个字段。
- **完成判定**
  - structured 链路出现 `memory_injected`，且仍能收到
    `structured_snapshot` 与 `structured_done`，最终 JSON 校验通过。
  - 用「生成用户列表表格」类输入做一次抽取，**确认不会**把列名/示例值记成记忆。
  - `allowMemory:false` 时零注入、零抽取。
- **不做**：不改抽取器提示词（若发现抽取器会把表格内容当事实，
  单独记到「待评估」，不在本指令里改共享组件）。

### 指令 6 · 前端契约与面板文案

- **动作**
  1. `api/chat.ts`：`streamPlan` / `streamStructured` 加 `userId`/`allowMemory`；
     `api/rag.ts` 同理。
  2. `composables/useChat.ts`：四条链路统一传
     `memoryUserId.value` / `allowMemory.value`（关闭时连 `userId` 一起不带）。
  3. `components/MemoryPanel.vue`：把「本阶段尚未接入记忆注入」的提示改成
     **按当前链路的真实状态**显示（四条都接完后改为常驻开关 + 状态说明）。
  4. `types.ts`：trace 事件类型补齐四条链路可能出现的记忆事件字段。
- **完成判定**
  - 四条链路在界面上都能看到「注入了 N 条记忆」的过程展示。
  - 关闭开关后四条链路均零注入、零抽取。
  - `npm run typecheck` 与 `npm run build` 通过。

### 指令 7 · 端到端测试

- **动作**
  1. 新增 `scripts/test-memory-chains.ts`：对四条链路各跑一组
     「写入记忆 → 换全新上下文提问 → 断言命中 → 删除 → 断言立即失效 →
     关闭开关 → 断言零注入」。
  2. 扩展 `scripts/test-chat-chains.ts`：在 multi / plan / rag / structured
     四条链路的断言里加「有 `memory_injected` 事件」与
     「`allowMemory:false` 时无该事件」。
  3. 硬断言 / 软指标分级沿用上一轮口径：系统行为必须全过，
     模型措辞类只记录不判负。
- **完成判定**
  - 四条链路的跨会话命中、删除即时生效、关闭即时生效全部通过。
  - `npm run test:memory`、`npm run test:chains`、`npm run test:memory-chains`
    三个脚本全绿。
- **注意**：plan 链路用小任务；测试用户用完清空记忆文件。

### 指令 8 · 文档与清单收尾

- **动作**
  1. `docs/memory.md` 增加「四条链路的接入差异」一节：
     每条链路的注入点、抽取输入、风险与实测结果。
  2. `docs/memory.md` 更新「为什么现在不做向量库」里与链路相关的表述
     （记忆现在在全部链路上都生效）。
  3. `tasks/todo.md`：Memory 节补 5.11～5.14（四条链路接入）与对应检查点，
     每条带实测结论；没跑的写「未运行」。
  4. `tasks/memory-chain-integration-plan.md`：进度表 + 「执行结果与补记」。
  5. `docs/memory.md` 补一张「四链路注入点对照表」。
- **完成判定**
  - 文档里的每个数字都来自实测，没有「感觉上是这样」的结论。
  - 清单不能只打勾，必须带实测结论。

---

## 6. 失败边界与隐私红线

| 场景 | 预期行为 |
| --- | --- |
| 检索失败（向量服务不可用） | 本轮不注入，记 `memory_failed`，回复照常 |
| 抽取失败（模型超时/非法 JSON） | 本轮不存，记 `memory_failed`，回复照常 |
| 用户关闭开关 | 四条链路一律零检索、零抽取 |
| `userId` 非法（不匹配 `anon_*`） | 服务端按「无记忆」处理，不报错 |
| 记忆块过长 | 沿用 Top-5 上限；本轮**不引入**新的预算裁剪机制 |
| RAG 检索片段含敏感信息 | 与现状一致，由检索侧负责；记忆块不参与 evidence |
| structured 的记忆内容含非法 JSON 字符 | 记忆块不进 JSON 输出路径，只进 system prompt |

隐私红线（四条链路共同遵守）：

- 记忆只进 **system prompt / 用户事实小节**，永远不进「引用来源」「资料编号」体系。
- 抽取输入里**永远排除**检索片段、工具返回、结构化输出内容。
- 记忆内容不写进日志正文（只记 id、条数、token 估算，与现有 trace 口径一致）。

---

## 7. 风险与已知坑

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| plan 链路变慢 | 每次 prompt 变长 | 记忆块很短；测试用小任务 |
| multi 成本 ×N | 4 个 worker 各带一份记忆 | 路由层只检索一次，共享同一块 |
| structured 被记忆污染 JSON | 记忆进了输出 | 抽取只用用户消息；验收专门看一次 |
| RAG 记忆被当成资料 | 引用编号错乱 | 独立小节，不进 evidence |
| 输出守卫误判 | 模型复述记忆被判泄露 | 记忆块标题用「用户长期记忆」，验收专项测 |
| 四条链路行为漂移 | 同一功能四种口径 | 统一走 `memory/bridge.ts` |
| 前端参数漏传 | 某条链路不生效 | 指令 7 的断言逐条覆盖 |

---

## 8. 验收标准

**功能**

- [ ] 四条链路都能注入当前用户的相关记忆，命中相似度 ≥ 0.45
- [ ] 四条链路关闭开关后零注入、零抽取
- [ ] 删除一条记忆后，四条链路的下一轮都不再注入它
- [ ] 四条链路都能在过程面板看到「注入 N 条 / 存下 N 条」
- [ ] 记忆失败不影响任一链路的正常回复
- [ ] RAG 的资料来源标注不被记忆污染
- [ ] structured 的最终 JSON 形状不受记忆影响

**兼容**

- [ ] `npm run test:memory` 硬断言全过
- [ ] `npm run test:chains` 6/6 通过
- [ ] `npm run test:memory-chains` 全过
- [ ] `npm run typecheck`、`npm run build` 通过

**性能**

- [ ] 单轮记忆检索开销：本地向量一次检索，耗时记入文档
- [ ] 抽取不阻塞回复（沿用「不 await」口径）

---

## 9. 复跑方式

| 命令 | 覆盖什么 |
| --- | --- |
| `npm run test:memory` | 单 Agent 跨会话 + 语义 spike + 并发/损坏（原样保留） |
| `npm run test:chains` | 五链路 + 记忆接口回归（含新增的四链路记忆断言） |
| `npm run test:memory-chains` | 四条链路的跨会话记忆命中/删除/关闭（新脚本） |
| `npx tsx scripts/check-memory-recall.ts` | 检索阈值标定（口径不变） |

---

## 10. 执行进度

| 指令 | 状态 | 验证结果 |
| --- | --- | --- |
| 1 · 抽公共接入层 | ✅ 已完成 | `typecheck` 通过；`test:memory` 硬断言 18/18；`test:chains` 6/6 |
| 2 · multi 链路接入 | ✅ 已完成（代码） | `typecheck` 通过；`test:chains` **未运行**（用户要求跳过实测，见 §11） |
| 3 · plan 链路接入 | ✅ 已完成（代码） | `typecheck` 通过；plan-execute 单元测试 56/56；`test:chains` **未运行**（见 §11） |
| 4 · rag 链路接入 | ✅ 已完成（代码） | `typecheck` 通过；`test:chains` **未运行**（见 §11） |
| 5 · structured 链路接入 | ✅ 已完成（代码） | `typecheck` 通过；`test:chains` **未运行**（见 §11） |
| 6 · 前端契约与面板文案 | ✅ 已完成（代码） | `typecheck` 通过；`test:chains` **未运行**（见 §11） |
| 7 · 端到端测试 | ⬜ 未开始 | — |
| 8 · 文档与清单收尾 | ⬜ 未开始 | — |

## 11. 执行结果与补记

### 指令 1 · 抽公共接入层（已完成）

**实际改动**

- 新增 `server/memory/bridge.ts`：导出 `retrieveMemoryBlock` / `scheduleMemoryExtraction`，
  以及 `MemoryBridgeOptions` / `MemoryExtractionDeps` 两个入参类型。
- 新增 `server/memory/index.ts`：记忆模块统一出口。
- `server/chat.ts`：删除两处私有实现，改为调用 bridge；
  抽出 `getMemoryConversationMessages()` 承担「挑哪些消息进抽取器」的职责。
- `server/memory/README.md`：文件地图补 `bridge.ts` / `index.ts`。

**与计划的差异**

- D1 草案里 `scheduleMemoryExtraction(options, messages, deps)` 的 `messages` 由调用方传入，
  实际实现照此落地：`chat.ts` 负责裁剪消息，bridge 只负责存。
  这样后续四条链路能各自按 D4 口径裁剪抽取输入，而不必改 bridge。

**实测**

- `npm run typecheck`：通过。
- `npm run test:memory`：硬断言 18/18 通过（跨会话命中、删除即时生效、关闭即停全部符合预期）。
- `npm run test:chains`：6/6 通过。

**环境备注**

- 网关上原 `.env` 配的 `deepseek-v4-flash` 当时无可用通道（503），
  改用同网关的 `deepseek-v4.1-flash` 跑通全部回归。
- plan 链路在默认 240s 超时下超时过一次；放宽到 600s 后 13～18s 正常跑完，
  是模型响应耗时而非接线问题。

### 指令 2 · multi 链路接入（代码已完成，实测待补）

**实际改动**

- `server/memory/bridge.ts`：新增 `buildExtractionInput(options)`，
  把 D4 的「抽取输入裁剪口径」抽成公共函数：
  只取最近 N 轮**用户消息** + 本轮给用户的最终回复，其余一概不取。
- `server/memory/index.ts`：同步导出。
- `server/multi-agent/workers/types.ts`：`WorkerContext` 增加 `memoryBlock?: ContextMemoryBlock`。
- `server/multi-agent/workers/memoryPrompt.ts`（新增）：`buildWorkerMessages(systemPrompt, task, memoryBlock)`，
  统一拼装 `system → 记忆(system) → task`；**无记忆时返回的数组与接入前逐字一致**。
- 四个 Worker（`generalWorker` / `kbWorker` / `actionWorker` / `realtimeWorker`）：
  初始 messages 改为调用上面的公共拼装函数，角色 prompt 一字未动。
- `server/multi-agent/graph.ts`：`MultiAgentGraphOptions` 增加 `memoryBlock`，
  由 workersNode 下发给每个 Worker。
- `server/routes/chatMulti.ts`：
  1. 读 `userId` / `allowMemory`，`isValidUserId` 校验；
  2. judge 之后、graph 之前**检索一次**记忆，命中则写 `memory_injected`（含 `itemIds` / `tokens` / `items`）；
  3. 把同一块 `memoryBlock` 经 graph options 下传（Supervisor / Aggregate **不注入**）；
  4. aggregate 之后按 D4 口径触发抽取（fire-and-forget，不阻塞回复）。
- `scripts/test-chat-chains.ts`：multi 的断言扩成三段——
  开关开（断言 `memory_injected` 且 `itemIds` 非空）、开关关（断言无 `memory_injected`）、
  抽取 0 条（断言记忆条数没变）。用独立匿名用户，避免被别的链路抽取污染。
- `server/multi-agent/README.md`：文件地图补 `workers/memoryPrompt.ts`，并说明记忆下发口径。

**与计划的差异**

- D4 的裁剪口径原本写在计划里，落地时抽成了 `buildExtractionInput` 而不是散落在各路由：
  plan / rag / structured 三条链路要的是同一套口径，抽成公共函数才不会抄成三份。
- 计划没规定「多 Agent 的抽取输入要不要保留中间的 assistant 回复」：
  实际取「最近 2 轮用户消息 + aggregate 最终回复」，
  中间的 assistant 回复里混着 worker 的工具返回和路由 JSON，按 D4 一律排除。

**实测**

- `npm run typecheck`：通过。
- `npm run test:chains`：**未运行**（用户明确要求跳过实测以省资源）。
  → 指令 2 的两条硬完成判定（命中断言 / 关闭即零注入）**目前只有代码、没有实测结论**，
  补跑方式：`LLM_MODEL=deepseek-v4.1-flash npm run test:chains`。

### 指令 3 · plan 链路接入（代码已完成，实测待补）

**实际改动**

- `server/chat.ts`：`CreateChatStreamOptions.memoryBlock` 落地为「**提供方已处理**」语义——
  传了（哪怕是 `null`）就不再检索、不再发 `memory_injected`、不再抽取；
  没传则行为与接入前完全一致。
  这是 plan 链路「一次请求只检索一次记忆」能成立的前提。
- `server/plan-execute/prompts.ts`：新增 `buildMemorySection(memoryBlock)`，
  有记忆时追加「## 用户长期记忆」小节，**无记忆时返回 `null`、一行都不加**；
  `buildPlanSystemPrompt` / `buildStepSystemPrompt` / `buildFinalReplySystemPrompt`
  三处共用它，并各自追加一段「【记忆使用边界】」。
- `server/plan-execute/planner.ts` / `executor.ts` / `finalReply.ts` / `replan.ts`：
  各自的 context 增加 `memoryBlock`，原样传给 prompt 构造器。
- `server/plan-execute/graph.ts`：`RunPlanGraphOptions.memoryBlock` 下发给
  planner / 每个 step / 最终回答 / re-plan，**全图共用路由层检索的那一块**。
- `server/routes/chatPlan.ts`：
  1. 请求 schema 增加 `userId` / `allowMemory`（可选）；
  2. 路由层检索**一次**记忆，命中则写 `memory_injected`；
  3. 同一块经 `runPlanExecute` 下传；
  4. react 兜底路径把 `userId` / `allowMemory` / `memoryBlock` 一起交给 `createChatStream`，
     由它以「独立 system 消息」的形式注入（与 multi 一致的注入形态）；
  5. 按 D4 口径触发抽取（最近 2 轮用户消息 + 本轮最终回答）。
- `server/plan-execute/prompts.test.ts`：新增两条断言——
  无记忆时三条 prompt 都不出现记忆小节，有记忆时都出现且带使用边界。
- `scripts/test-chat-chains.ts`：plan 的断言扩成三段——
  不带 `userId`（零检索零注入）、开关开（断言 `memory_injected` 且 `itemIds` 非空）、
  抽取 0 条（断言记忆条数没变）。用独立匿名用户，避免被别的链路抽取污染。

**与计划的差异**

- 计划 §4.2 写的是「step 的注入点放在 `buildStepSystemPrompt` **之后**，作为独立 system 消息」，
  实际落地成「**追加到 prompt 末尾的小节**」，三条 prompt 形态统一。
  理由：计划里「独立 system 消息」的说法是针对 `/api/chat` 那种「拼 messages 数组」的结构；
  plan 的三条 prompt 都是**单条 system 字符串**，
  拆成两条消息要改的是 messages 结构（executor 还要回填 tool 结果），改动面更大、回归风险更高。
  记忆块的措辞（`MEMORY_BLOCK_HEADER`）没有变，注入位置仍在角色约束之后。
- 计划没规定 re-plan 要不要带记忆：实际**带**（同一块），
  因为 re-plan 用的也是同一套 plan prompt，背景信息理应一致；
  并加了边界说明，防止重规划时把记忆当成待办事项。
- 计划只提「final reply 之后触发抽取」；实际把抽取统一放在**路由层**，
  覆盖 plan 模式与 react 回退两种路径（react 回退的最终回答由 delta 累积得到），
  这样「一次请求只抽一次」的口径不依赖走的是哪条分支。

**实测**

- `npm run typecheck`：通过。
- `node --import tsx --test server/plan-execute/*.test.ts server/routes/chatPlan.test.ts`：
  56/56 通过（纯本地 mock，不调模型）。
- `npm run test:chains`：**未运行**（用户明确要求跳过实测以省资源）。
  → 指令 3 的硬完成判定里「plan 链路出现 `memory_injected`」「计划未被记忆污染」
  「`allowMemory:false` 零注入」**目前只有代码、没有实测结论**，
  补跑方式：`LLM_MODEL=deepseek-v4.1-flash PLAN_TIMEOUT_MS=600000 npm run test:chains`。
  其中「计划未被记忆污染」需要人工看一次 planner 产出的计划内容（断言只能覆盖事件形状）。

### 指令 4 · rag 链路接入（代码已完成，实测待补）

**实际改动**

- `server/memory/context.ts`：新增 `MEMORY_SECTION_TITLE` 与 `renderMemorySection(block)`——
  「只有一条 system 字符串」的链路（plan / rag / structured）统一用它把记忆渲染成
  **带标题的小节**；没有记忆时返回 `null`，调用方一行都不加。
  与 `renderMemoryText`（给「拼 messages 数组」的链路用的裸文本）分工明确。
- `server/memory/index.ts`：同步导出。
- `server/plan-execute/prompts.ts` / `replan.ts`：改用上面这个公共渲染器，
  不再各自私有一份（指令 3 里的 `buildMemorySection` 已被替换掉）。
- `server/rag/prompt.ts`：`BuildRagPromptInput` 增加 `memoryBlock`；
  有记忆时在「## 资料」**之后**追加独立的「## 用户长期记忆」小节，
  并附一句「不是检索资料，不要给它编号」——
  记忆混进 evidence 会让模型把它当成检索来源，引用编号对不上。
  **无记忆时 prompt 与改造前逐字一致。**
- `server/rag/answer.ts`：`answerFromDocs` 的第 7 个入参由 `usageHooks` 扩成 `options`，
  增挂 `memoryBlock`（只改名字与多一个字段，调用方逐个具名传参，行为不变）。
- `server/routes/ragChat.ts`：
  1. 读 `userId` / `allowMemory`，`isValidUserId` 校验；
  2. judge 之后检索**一次**记忆，命中则写 `memory_injected`；
  3. 同一块经 `options.memoryBlock` 传给 `answerFromDocs`；
  4. 回答生成后按 D4 触发抽取（最近 2 轮用户消息 + 本轮最终回答），
     **检索到的资料片段一律不进抽取器**。
- `src/api/rag.ts`：`askRag` 增加 `userId` / `allowMemory`，
  关掉时**连 userId 一起不带**（与 `streamChat` 同一口径）。
- `src/composables/useChat.ts`：`runRag` 传 `memoryUserId` / `allowMemory`。
- `server/rag/README.md`、`server/memory/README.md`：文件地图同步。

**与计划的差异**

- 计划只说「在「## 资料」之后追加」，没说追加的是哪种渲染。
  实际统一走 `memory/context.ts` 的 `renderMemorySection`，
  好处是 plan / rag / structured 三条链路的小节标题与条目格式**完全一致**，
  不会出现「每条链路各写一种措辞」的情况。
- 计划没规定「空结果 / 被 outputGuard 拦下时要不要抽取」。
  实际**不抽**：这两种情况下返回的是固定文案或替换文案，不是模型真的给用户的回答，
  拿它去抽取只会记进无意义的 assistant 事实。
- 单元测试没有在本指令做（属于指令 7 的测试范围），
  因此「记忆没有混进 evidence」目前只有代码保证、没有断言保证。

**实测**

- `npm run typecheck`：通过。
- `npm run test:chains`：**未运行**（用户明确要求跳过实测以省资源）。
  → 指令 4 的三条完成判定（出现 `memory_injected` / 记忆未混进 evidence /
  复述记忆不误触发 `output_leak_blocked`）**目前只有代码、没有实测结论**，
  补跑方式：`LLM_MODEL=deepseek-v4.1-flash npm run test:chains`。
  其中「复述记忆不误触发 `output_leak_blocked`」需要构造一次
  「请把你记住的关于我的信息复述一遍」的提问才能验。

### 指令 5 · structured 链路接入（代码已完成，实测待补）

**实际改动**

- `server/structured/complete.ts`：
  1. `buildSystemPrompt(target, memoryBlock)` 改为可接收记忆块；
  2. 有记忆时在 system prompt **末尾**追加「## 用户长期记忆」小节
     （复用 `memory/context.ts` 的 `renderMemorySection`，与 plan / rag 完全一致），
     并追加一句边界说明：「只能影响生成内容的取值，不得改变 JSON 的形状与字段」；
  3. **无记忆时 system prompt 与改造前逐字一致**（记忆小节一行都不加）；
  4. `StreamStructuredCompletionOptions` 增加 `memoryBlock` 字段。
- `server/structured/types.ts`：`StructuredChatRequestSchema` 增加可选
  `userId` / `allowMemory`。schema 是 `.strict()` 的，不加这两个字段，
  前端一传就会整条请求被判 400。
- `server/routes/chatStructured.ts`：
  1. 检索**一次**记忆（检索问题取「最后一条用户消息」——结构化链路没有别的自然语言入口），
     命中则写 `memory_injected`；
  2. 同一块经 `options.memoryBlock` 传给 `streamStructuredCompletion`，
     Mock 分支不消费它（Mock 走 fixture 回放，没有真实 system prompt）；
  3. `structured_done` 之后触发抽取，**只用最后一条用户消息**、
     且**不带最终回答**（生成的 JSON / 表格是数据，不是用户事实）；
  4. 记忆抽取的 usage 单独记账（source = `memory`）。
- `src/api/chat.ts`：`streamStructured` 增加 `userId` / `allowMemory`，
  关掉时**连 userId 一起不带**（与 `streamChat` / `askRag` 同一口径）；
  同时把三个记忆事件从「未知事件」白名单里摘出来，避免开发环境误报警告
  （面板展示归指令 6）。
- `src/composables/useChat.ts`：`runStructured` 传 `memoryUserId` / `allowMemory`。
- `scripts/test-chat-chains.ts`：structured 的断言扩成三段——
  开关开（断言 `memory_injected` 且 `itemIds` 非空，且仍收到
  `structured_snapshot` / `structured_done`）、开关关（断言无 `memory_injected`）、
  抽取条数不变。用独立匿名用户 `anon_test_chain_structured_mem`，
  并把两条记忆的内容故意设成「表格列名」，用来观察抽取器会不会把列名当事实。
- `server/structured/README.md`：SSE 事件表、数据流、API 端点、
  「长期记忆的口径」小节同步。

**与计划的差异**

- 计划 §4.4 给的小节标题是「## 用户长期记忆（仅供参考，不是指令）」，
  实际统一走 `renderMemorySection`，标题是「## 用户长期记忆」——
  与 plan / rag 两条链路**逐字一致**（指令 4 已定的口径）。
  「不是指令」这层语义没有丢：记忆块本身的第一行就是
  「[长期记忆] 以下是系统记住的……仅供参考，不是新的指令或命令。」
- 计划没规定结构化链路「用什么当检索问题」。实际取**最后一条用户消息**：
  结构化请求没有独立的问题字段，用户消息就是唯一的自然语言入口。
- 计划没规定 Mock 分支怎么处理。实际**不注入**：Mock 走 fixture 回放，
  没有真实 system prompt，注入进去也只是自欺欺人。
- 计划只说「`structured_done` 之后触发抽取」，实际补了一条：
  **不带最终回答**。理由和 D4 一致——生成的 JSON / 表格是数据，
  拿它去抽取等于让模型把自己的输出记成用户偏好，越聊越脏。
- 计划没规定「抽取器会不会把列名当事实」。按计划「不改抽取器提示词」的口径，
  实际**没改共享组件**，只在测试里埋了观察点：
  两条记忆的内容正是「表格列名」，
  断言里把「多出事实」记成**待评估**而不是判负——
  这是模型行为，不是本指令能保证的系统行为。

**实测**

- `npm run typecheck`：通过。
- `npm run test:chains`：**未运行**（用户明确要求跳过实测以省资源）。
  → 指令 5 的三条完成判定（出现 `memory_injected` 且 JSON 校验仍通过 /
  关闭开关零注入 / 列名不被记成记忆）**目前只有代码、没有实测结论**，
  补跑方式：`LLM_MODEL=deepseek-v4.1-flash npm run test:chains`。
  其中「列名不被记成记忆」要看 structured 那条用例的 detail 里
  「抽取 0 条新事实」还是「多出 N 条事实（待评估）」。

---

### 指令 6 · 前端契约与面板文案（代码已完成，实测待补）

**实际改动**

- `src/api/memoryTrace.ts`（新增）：`parseMemoryTraceStep(event)`，
  统一解析 `memory_injected` / `memory_extracted` / `memory_failed` 三种 SSE 事件，
  脏数据一律降级（缺字段补默认值）而不是让流崩掉。
  单独成文件的原因：四条链路各写一遍 SSE 解析，迟早会漏掉某一种事件。
- `src/types.ts`：`ToolTraceStep` 联合类型补 `memory_failed` 变体
  （`stage: "retrieve" | "extract" | "store"` + `message`）。
- `src/api/chat.ts`：
  1. `streamPlan` / `streamStructured` 增加 `userId` / `allowMemory`，
     请求体统一按 `...(allowMemory && userId ? { userId, allowMemory: true } : { allowMemory: false })` 传——
     关掉时**连 userId 一起不带**，服务端零检索零抽取；
  2. `streamPlan` / `streamStructured` 的 SSE 循环接 `parseMemoryTraceStep`；
  3. `streamChat` 里原本手写的 `memory_injected` / `memory_extracted` 解析
     **换成同一个 `parseMemoryTraceStep`**（顺带多支持了 `memory_failed`），
     避免同一份协议在前端有两套实现；
  4. `streamStructured` 增加 `onTrace` 回调，把记忆事件送进工具过程面板。
- `src/api/rag.ts`：`askRag` 增加 `userId` / `allowMemory`，
  SSE 事件类型补齐记忆相关字段，接 `parseMemoryTraceStep`。
- `src/composables/useChat.ts`：`runPlan` / `runStructured` / RAG 三处
  统一传 `memoryUserId.value` / `allowMemory.value`；
  `runStructured` 的 `start` 回调把 `onTrace` 透传给 `streamStructured`。
- `src/components/MemoryPanel.vue`：
  1. 新增 `chainLabel` prop（默认「普通对话（/api/chat）」）；
  2. `injectionSupported` 的语义从「多 Agent 没接」改成「**当前链路**是否支持记忆注入与抽取」；
  3. 提示文案改成三态——开关关闭（关闭说明）/ 当前链路未接入（黄色警告）/
     当前链路已接入（绿色说明），文案里带上具体链路名。
- `src/components/ToolTracePanel.vue`：补 `memory_failed` 的标题与载荷分支，
  新增 `memoryStageText()`（retrieve→检索 / extract→抽取 / store→保存），
  并在面板里单独渲染一行「不影响本轮回答」。
- `src/App.vue`：
  1. `memoryInjectionSupported` 改为 `() => !reflectionEnabled.value`
     ——四条业务链路 + 普通对话都已接入，只有反思复盘还没接；
  2. 新增 `memoryChainLabel` computed（rag / structured / plan / reflection / multi / 普通）；
  3. 新增 `memoryTraceSteps` computed；
  4. 侧栏接线：RAG 模式原本整块隐藏 `ToolTracePanel`，
     现在改成「RAG 模式只渲染记忆相关步骤、其它链路渲染全量」，
     并让 `hasSideContent` 在「RAG 模式且有记忆事件」时也展开侧栏——
     否则资料问答链路注入了什么记忆，用户在界面上完全看不见。

**与计划的差异**

- 计划 §3 D6 只说了「复用同一组字段与同一套开关」，
  实际落地时多抽了一层：`parseMemoryTraceStep` 把三种记忆事件的解析也统一了。
  字段统一不够——解析逻辑分叉一样会漂移（`streamChat` 原本就是手写的另一份）。
- 计划 §指令 6 第 3 条只说「把提示改成按当前链路的真实状态显示」，
  实际多了一个 `chainLabel` prop：
  光说「没接入」用户不知道自己在哪条链路上，说清楚链路名才有用。
- 计划没提 RAG 侧栏。实际发现：RAG 模式下侧栏被命中面板独占，
  记忆事件如果按原样 `v-if="!ragMode"` 会被一起藏掉——
  这会让「指令 4 的注入在界面上不可见」，
  所以补了 RAG 模式下的记忆步骤过滤 + 侧栏展开条件。

**实测**

- `npm run typecheck`：**通过**（`vue-tsc --noEmit` + `tsc -p tsconfig.server.json --noEmit`）。
- `npm run build`：**未运行**（用户要求只跑 typecheck）。
- `npm run test:chains`：**未运行**（用户明确要求跳过实测以省资源）。
  → 指令 6 的三条完成判定里，「四条链路在界面上都能看到『注入了 N 条记忆』的过程展示」
  和「关闭开关后四条链路均零注入、零抽取」
  **目前只有代码、没有实测结论**，补跑方式：
  `LLM_MODEL=deepseek-v4.1-flash npm run test:chains`。
  界面层面的三条链路（非 RAG / RAG / 结构化）建议人工点一遍确认面板文案与颜色。

---

*执行顺序：指令 1 → 8，每条做完再进下一条。*
