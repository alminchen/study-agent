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

*本文档为计划，尚未实现。执行顺序：指令 1 → 8，每条做完再进下一条。*
