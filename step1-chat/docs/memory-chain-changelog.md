# 跨会话记忆接入四条链路（阶段 9 · 代码已完成 / 实测待补）

> 阶段 8 的记忆能力只接进了 `POST /api/chat`。
> 阶段 9 把 multi / plan / rag / structured 四条业务链路接进来，
> 口径统一、行为不漂移、失败不阻断。

## 一句话

抽出公共接入层 `memory/bridge.ts`；路由层**检索一次**、整条链路共用同一块记忆；
四份 prompt 按各自形状注入；抽取输入按链路裁剪；失败一律旁路只发事件。

## 为什么加这一层

阶段 8 的记忆能存能查，但只有普通对话用得上。四个具体后果：

1. 用户在普通对话里说了偏好，切到资料问答完全不生效——记忆面板却列着这条事实，
   形成「记住了但没生效」的错觉。
2. 四条链路各写一份检索 / 注入 / 抽取，阈值、Top-5、资料口径迟早对不上。
3. multi 有 4 个 worker，逐 worker 检索就是一次请求 4 次向量检索。

## 本阶段做了什么

- **新增公共接入层** `memory/bridge.ts`：检索、抽取编排、抽取输入裁剪、事件构造四件事收在一处。
- **multi**：路由层检索一次 → 独立 system 消息注入 4 个 worker（Supervisor / Aggregate 不注入）。
- **plan**：路由层检索一次 → 追加小节进 planner / step / 终答 / re-plan 四处 prompt；
  react 兜底路径复用 `chat.ts` 的注入形态。
- **rag**：judge 后检索一次 → 追加小节放在「## 资料」之后，不进引用编号体系。
- **structured**：检索一次 → 追加小节进 system prompt 末尾，带「不得改变 JSON 形状」边界。
- **前端**：统一 `userId` / `allowMemory` 请求契约；统一事件解析 `api/memoryTrace.ts`；
  面板提示改成按当前链路显示的三态。

## 新增文件（7）

| 文件 | 作用 |
| --- | --- |
| `memory/bridge.ts` | 公共接入层：`retrieveMemoryBlock` · `scheduleMemoryExtraction` · `buildExtractionInput` · `buildMemoryInjectedEvent` |
| `memory/index.ts` | 记忆模块统一出口 |
| `multi-agent/workers/memoryPrompt.ts` | `buildWorkerMessages(systemPrompt, task, memoryBlock)`——无记忆时逐字不变 |
| `api/memoryTrace.ts` | `parseMemoryTraceStep(event)`——统一解析三种记忆事件，脏数据降级 |
| `docs/memory-chain-integration.md` | 阶段完整说明 |
| `docs/memory-chain-changelog.md` | 阶段变更记录（本文件） |
| `docs/memory-chain-flow.svg` | 阶段 9 细泳道流程图 |

## 修改文件（41）

### 服务端 · 公共层

| 文件 | 改动 |
| --- | --- |
| `chat.ts` | 删掉两处私有实现改调 bridge；`CreateChatStreamOptions.memoryBlock` 落地为「提供方已处理」语义（传了就不再检索 / 不再发事件 / 不再抽取） |
| `memory/context.ts` | 新增 `MEMORY_SECTION_TITLE` 与 `renderMemorySection()`——plan / rag / structured 三条链路的记忆小节逐字一致 |
| `memory/README.md` | 文件地图补 `bridge.ts` / `index.ts`，补公共层职责说明 |

### 服务端 · multi

| 文件 | 改动 |
| --- | --- |
| `routes/chatMulti.ts` | 读 `userId` / `allowMemory` → judge 后检索一次 → 发 `memory_injected` → 下传 → aggregate 后抽取 |
| `multi-agent/graph.ts` | `MultiAgentGraphOptions.memoryBlock` → workersNode 下发 |
| `multi-agent/workers/types.ts` | `WorkerContext.memoryBlock` |
| `multi-agent/workers/generalWorker.ts` | 初始 messages 走公共拼装 |
| `multi-agent/workers/kbWorker.ts` | 同上 |
| `multi-agent/workers/actionWorker.ts` | 同上 |
| `multi-agent/workers/realtimeWorker.ts` | 同上 |
| `multi-agent/README.md` | 文件地图补 `workers/memoryPrompt.ts`，说明记忆下发口径 |

### 服务端 · plan

| 文件 | 改动 |
| --- | --- |
| `routes/chatPlan.ts` | 请求 schema 加 `userId` / `allowMemory`；路由层检索一次并发事件；下传；react 兜底路径带上 `memoryBlock`；统一抽取 |
| `plan-execute/prompts.ts` | 新增 `buildMemorySection()`；`buildPlanSystemPrompt` / `buildStepSystemPrompt` / `buildFinalReplySystemPrompt` 三处共用，各自追加「【记忆使用边界】」 |
| `plan-execute/planner.ts` | context 增加 `memoryBlock` |
| `plan-execute/executor.ts` | 同上 |
| `plan-execute/finalReply.ts` | 同上 |
| `plan-execute/replan.ts` | 同上 |
| `plan-execute/graph.ts` | `RunPlanGraphOptions.memoryBlock` 全图下传 |
| `plan-execute/prompts.test.ts` | 新增两条断言：三条 prompt 无记忆时不出现记忆小节，有记忆时都出现且带边界 |
| `plan-execute/README.md` | 补记忆注入口径 |

### 服务端 · rag

| 文件 | 改动 |
| --- | --- |
| `routes/ragChat.ts` | judge 后检索一次并发事件；下传；回答后抽取（检索片段不进抽取器） |
| `rag/prompt.ts` | 「## 资料」之后追加「## 用户长期记忆」，并写明「不要给它编号」 |
| `rag/answer.ts` | `answerFromDocs` 第 7 参扩为 `options`（承载 `memoryBlock`） |
| `rag/README.md` | 补记忆注入口径 |

### 服务端 · structured

| 文件 | 改动 |
| --- | --- |
| `routes/chatStructured.ts` | 检索一次并发事件；下传；`structured_done` 之后只抽取最后一条用户消息；记忆 usage 单独记账 |
| `structured/complete.ts` | `buildSystemPrompt(target, memoryBlock)` 末尾追加记忆小节 +「不得改变 JSON 形状与字段」；**无记忆时 prompt 逐字不变** |
| `structured/types.ts` | `StructuredChatRequestSchema` 加可选 `userId` / `allowMemory`（schema 是 `.strict()` 的，不加会 400） |
| `structured/README.md` | SSE 事件表 / 数据流 / 长期记忆口径同步 |

### 前端

| 文件 | 改动 |
| --- | --- |
| `api/chat.ts` | `streamPlan` / `streamStructured` 加 `userId` / `allowMemory`；`streamChat` 手写的记忆解析换成 `parseMemoryTraceStep`；`streamStructured` 加 `onTrace` |
| `api/rag.ts` | `askRag` 加 `userId` / `allowMemory`；事件类型补记忆字段；接统一解析 |
| `composables/useChat.ts` | plan / structured / rag 三处统一传 `memoryUserId.value` / `allowMemory.value` |
| `types.ts` | `ToolTraceStep` 补 `memory_failed` 变体（`stage` + `message`） |
| `App.vue` | `memoryInjectionSupported` 改为「只有 reflection 没接」；新增 `memoryChainLabel` 与 `memoryTraceSteps`；RAG 侧栏接线 |
| `components/MemoryPanel.vue` | 新增 `chainLabel`；提示改三态并带链路名；新增 `.notice.on` 样式 |
| `components/ToolTracePanel.vue` | 补 `memory_failed` 标题与载荷分支；新增 `memoryStageText()` |

### 脚本与文档

| 文件 | 改动 |
| --- | --- |
| `scripts/test-chat-chains.ts` | 四条链路各加三段记忆断言：开关开（有 `memory_injected` 且 `itemIds` 非空）/ 开关关（无该事件）/ 抽取条数不变 |
| `docs/flows-index.html` | 0g Memory 入口更新；新增「阶段 9 文件清单」区块 |
| `docs/flows-index.md` | 同上（Markdown 版索引） |
| `docs/project-topology.html` | §6h 接入现状改为已接入；新增 §6i 阶段 9 方法级拓扑 |
| `docs/memory-flow.svg` | 阶段 8 图的链路现状段由「四链路未接入」改为「五链路已接入」，并补各链路注入点与抽取时机说明 |
| `README.md` | 能力表补长期记忆一行；目录树补 `memory/` 与 `memoryTrace.ts` |

## 记忆契约（五条链路一致）

| 环节 | 口径 |
| --- | --- |
| 检索门槛 | `SIMILARITY_THRESHOLD` = 0.45 |
| 召回条数 | `MEMORY_INJECT_LIMIT` = Top-5 |
| 预算裁剪 | `MEMORY_CONTEXT_TOKEN_CAP` = 200 · `MEMORY_CONTEXT_BUDGET_RATIO` = 0.1 |
| 检索次数 | 每请求 **1** 次（路由层），四条链路共用同一块 |
| 注入形态 | multi / 普通对话 = 独立 system 消息；plan / rag / structured = 追加小节 `## 用户长期记忆` |
| 抽取触发 | fire-and-forget，不 await，不使用请求的 AbortSignal |
| 抽取输入 | `buildExtractionInput({ messages, finalReply, rounds })`：最近 N 轮**用户消息** + 可选最终回复 |
| 失败行为 | 旁路，只发 `memory_failed`，回复照常 |
| 关闭开关 | 前端**不带** `userId` → 服务端零检索零抽取 |

## 四链路差异一览

| 维度 | multi | plan | rag | structured |
| --- | --- | --- | --- | --- |
| 注入点 | worker 的 system | planner / step / 终答 / re-plan | 「## 资料」之后 | system prompt 末尾 |
| 抽取时机 | aggregate 之后 | 最终回答之后 | 回答之后 | `structured_done` 之后 |
| 抽取输入 | 2 轮用户消息 + aggregate 回复 | 2 轮用户消息 + 终答 | 2 轮用户消息 + 终答 | **仅最后一条用户消息** |
| 带最终回答 | 是 | 是 | 是 | **否** |
| 特殊约束 | Supervisor / Aggregate 不注入 | react 兜底复用单 Agent 形态 | 不进引用编号体系 | 不得改变 JSON 形状 |

## 隐私设计（不是附加项，是约束）

- 记忆只进 system prompt / 用户事实小节，**永远不进**引用来源与资料编号体系。
- 抽取输入**永远排除**检索片段、工具返回、结构化输出内容。
- 记忆内容不写进日志正文，只记 id / 条数 / token 估算。
- 两道敏感信息闸（送模型前脱敏、模型输出后拦一次）阶段 8 已定，本阶段复用未改。
- 冲突不自动覆盖，仍由用户在面板裁决。

## 实测结果

**这一段必须说清楚边界**：

| 项 | 状态 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm run build` | ❌ **未运行**（用户要求只跑 typecheck） |
| `npm run test:chains` | ❌ **未运行**（用户要求跳过实测以省资源） |
| `npm run test:memory` | ❌ 未在本阶段运行 |
| `npm run test:memory-chains` | ❌ 脚本还没建（归指令 7） |
| 端到端单元测试 | ❌ 未写（用户明确说还没到这一步） |

**代码层面的保证**（可静态核对，不需要跑）：

- 四条链路的检索次数都是 1——检索只出现在路由层，业务层没有第二处调用点。
- 关闭开关时前端不带 `userId`，服务端入口校验直接返回「无记忆」。
- 无记忆时 multi 的 worker messages、structured 的 system prompt 与接入前逐字一致。

**需要实测才能下结论**（目前没有结论）：

- 四条链路都能发出 `memory_injected`，且界面能看到「注入了 N 条」。
- 关闭开关后四条链路零注入零抽取。
- structured 的记忆内容不会改变 JSON 形状与字段。
- RAG 的记忆不会被编号成引用来源。
- 删除一条记忆后四条链路的下一轮都不再注入它。

补跑方式：

```bash
LLM_MODEL=deepseek-v4.1-flash npm run test:chains
```

`.env` 里原配的 `deepseek-v4-flash` 在网关上当时无可用通道（会 503）；
plan 链路需要 `PLAN_TIMEOUT_MS=600000`。

## 已知缺口

- 四条链路未实测（见上）。
- 端到端跨会话脚本 `scripts/test-memory-chains.ts` 未建。
- 单元测试未写。
- structured「表格列名被当成事实」只埋了观察点，没改抽取器共享组件——
  这是模型行为，不是本阶段能保证的系统行为。
- reflection 链路未接入记忆，面板如实标注为「未接入」。

## 下一步

1. 建 `scripts/test-memory-chains.ts`：写入记忆 → 换全新上下文提问 → 断言命中 →
   删除 → 断言立即失效 → 关闭开关 → 断言零注入。
2. 跑 `npm run test:chains` 与新脚本，把本文件「实测结果」一节的「未运行」全部换成真实数字。
3. 补 `docs/memory.md` 的「四链路接入差异」一节与 `tasks/todo.md` 的 5.11～5.14。

## 配套文档

- [memory-chain-integration.md](./memory-chain-integration.md) — 阶段 9 完整说明
- [memory-chain-flow.svg](./memory-chain-flow.svg) — 阶段 9 流程图
- [memory.md](./memory.md) · [memory-changelog.md](./memory-changelog.md) — 阶段 8
- [project-topology.html §6i](./project-topology.html#memory-chain) — 方法级拓扑
- `tasks/memory-chain-integration-plan.md` — 计划与逐条执行记录
