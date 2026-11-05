# 项目交互与 messages 拼接说明

> 泳道流程图（方法名 + 调用链）：
>
> - 总览：[messages-assembly-flow.svg](./messages-assembly-flow.svg)
> - 单 Agent：[chat-react-flow.svg](./chat-react-flow.svg)
> - 多 Agent：[chat-multi-flow.svg](./chat-multi-flow.svg)
> - 资料问答：[rag-chat-flow.svg](./rag-chat-flow.svg) · Guard 改动清单：[rag-input-output-guard-changelog.md](./rag-input-output-guard-changelog.md)
> - Streaming 结构化输出：[structured-output-flow.svg](./structured-output-flow.svg) · 总结：[structured-output.md](./structured-output.md) · 拓扑：[§6c](./project-topology.html#structured)
> - Plan-and-Execute：[plan-and-execute-flow.svg](./plan-and-execute-flow.svg) · 架构说明：[plan-and-execute.md](./plan-and-execute.md) · 拓扑：[§6d](./project-topology.html#plan)
> - 人工确认：[human-confirm-flow.svg](./human-confirm-flow.svg)
> - 索引：[flows-index.md](./flows-index.md)

## 一、先记住三层

| 层级 | 存什么 | 有没有 system |
|------|--------|---------------|
| **前端 UI** | `ChatMessage[]`（user / assistant），localStorage | 无 |
| **HTTP 请求体** | 前端发给 API 的 `{ role, content }[]` | 无（普通聊天 / multi） |
| **发给 LLM** | 服务端拼装后的 `messages` | 有，且由服务端注入 |

前端永远只维护 **user / assistant** 对话气泡；**system 不出现在 UI 历史里**。

---

## 二、前端四种聊天/检索模式

> 表格/代码结构化输出使用独立模式，请求、快照和最终校验见
> [structured-output.md](./structured-output.md)。
>
> 计划模式走独立端点 `POST /api/chat/plan`，路由判定、计划契约与 Re-plan 边界见
> [plan-and-execute.md](./plan-and-execute.md)。

```
App.vue / useChat.ts
│
├─ 普通对话（ragMode=false）
│    localStorage: step1-chat:history
│    POST /api/chat 或 /api/chat/multi（当前默认 multi）
│    可选：searchKb 勾选 → body.searchDocs=true
│
├─ 资料问答（ragMode=true）
│    localStorage: step1-chat:rag-history
│    POST /api/rag/chat
│
├─ 计划模式（planEnabled=true）
│    localStorage: 同普通对话 history
│    POST /api/chat/plan
│    mode: auto | react | plan
│    PlanTimeline（计划 + 步骤状态，只在内存）
│
└─ 展示
     ToolTracePanel（工具过程）
     RagHitPanel（命中 chunk）
     UsagePanel（token）
     PlanTimeline（计划时间线，仅计划链路）
```

发送时前端只 map 出：

```ts
messages: history.map(({ role, content }) => ({ role, content }))
// 只有 user | assistant，不含 system
```

---

## 三、链路 A：`POST /api/chat`（单 Agent ReAct）

文件：`server/chat.ts` → `buildContext`（budget）/ `clipMessages`（legacy）→ `runConversation` → LangGraph

### 3.1 前端 → 服务端

```json
{
  "messages": [
    { "role": "user", "content": "广州天气" },
    { "role": "assistant", "content": "..." },
    { "role": "user", "content": "顺便查查几点" }
  ],
  "searchDocs": false,
  "model": "deepseek-chat"
}
```

### 3.2 上下文构建后（发给模型的起点）

`server/context/buildContext.ts`：采用分层构建策略（Budget 模式）。

- **System**: 固定保留核心系统提示。
- **Summary**: 若对话超限，注入由 `summarize.ts` 生成的结构化摘要。
- **Window**: 保留最近 N 轮原文。
- **Pairing**: 强制保证 Tool Call 与 Result 成对出现。

*(注：`server/clipMessages.ts` 仍被保留以支持 legacy 模式，行为与改造前完全一致)*

```
[
  { role: "system", content: buildSystemPrompt(searchDocs) },  ← 服务端拼
  { role: "user", ... },
  { role: "assistant", ... },
  { role: "user", ... }   ← 最后一条通常是本轮问句
]
```

`buildSystemPrompt(searchDocs)` 组成（`server/chat.ts`）：

```
SYSTEM_PROMPT                    工具规则（天气/时间/…）
+ SYSTEM_PROMPT_KB_ON/OFF        本轮是否开了「搜索知识库」
+ SYSTEM_PROMPT_GUARD              防注入
```

### 3.3 勾选「搜索知识库」时（prefetch，仍在 ReAct 前）— **语义 C**

`prefetchSearchDocsIfEnabled` 不改 messages 结构，只**追加到 system.content**：

```
system.content +=
  【本轮知识库检索结果】...
  [1] id=... source=... title=...
  chunk 原文...
  [2] ...
```

- 判空 → 不调 LLM，直接固定文案回复
- 有资料 → 继续 ReAct；**requestCompletion 固定不挂 searchDocs**（只剩天气/时间/确认类工具）
- LangSmith：`chat-prefetch` span；候选数可用 `CHAT_CANDIDATE_K`

### 3.4 ReAct 循环中 messages 如何变长

LangGraph：`askModel` ↔ `applyTools` → `reply`

每一轮 **askModel** 可能追加：

```
{ role: "assistant", content: null, tool_calls: [...], reasoning_content?: ... }
{ role: "tool", tool_call_id: "...", content: "{...json...}" }
{ role: "tool", tool_call_id: "...", content: "{...json...}" }
... 再问模型 ...
{ role: "assistant", content: "最终给用户看的文字" }  ← 无 tool_calls，结束
```

**注意**：`assistant+tool_calls` 和 `role:"tool"` 只存在于**本轮请求内存**，不会写回前端 localStorage。

### 3.5 返回前端（SSE）

| 事件 | 含义 |
|------|------|
| `tool_call` / `tool_result` | 过程面板 |
| `delta` | 最终文字（可能一次性整段） |
| `usage` | token 统计 |
| `[DONE]` | 结束 |

---

## 四、链路 B：`POST /api/chat/multi`（多 Agent）

文件：`server/index.ts` → `graph.ts`

### 4.1 前端 → 服务端

body 同样带 `messages[]`，但服务端**几乎只用最后一条 user**：

```ts
const lastUser = [...messages].reverse().find(m => m.role === "user");
// graph.invoke({ userMessage: lastUser.content, ... })
```

历史 user/assistant **当前未传入** Supervisor（设计简化）。

### 4.2 内部 LLM 调用（各自独立 messages，不是一条长 chat 史）

| 节点 | 发给 LLM 的 messages 形状 |
|------|---------------------------|
| Supervisor | `[system 路由规则, user 本轮问句]` + route tool |
| Worker | `[system Worker 专用, user 子任务]` + 工具 schema |
| Aggregate | `[system 汇总规则, user 各 Worker 输出]` |

Worker 内部 mini ReAct 也会出现 `assistant+tool_calls` + `tool` 回填，逻辑同单 Agent，但**隔离在 Worker 内**。

### 4.3 返回前端（SSE）

```
supervisor_route → worker_done × N → delta → usage → [DONE]
```

前端 **ToolTracePanel 默认只认单 Agent 的 tool_call 事件**，multi 的过程事件类型不同。

---

## 五、链路 C：`POST /api/rag/chat`（资料问答）

文件：`server/routes/ragChat.ts` → `server/rag/answer.ts` → `buildRagPrompt`

响应形态：**SSE**（与 chat / multi 对齐）。

安全 + 可观测（与 chat 对齐语义）：
- **Input**：`detectInjection(question)` → 只标记；SSE `injection_detected`
- **Tool**：检索前 `validateToolCall("searchDocs", { question })`；拒绝则 `tool_result.error`、不 retrieve
- **Output**：`detectLeakage` → 可能换 safeText；SSE `output_leak_blocked`
- **SSE Trace**：`tool_call` / `tool_result` / 防护事件 → ToolTracePanel；命中另发 `rag_meta` → RagHitPanel
- **LangSmith**：`rag-request` → `rag-retrieve` → `rag-llm`（需 tracing 开关）
- **Token**：`bindUsage("rag")` → `writeUsageToStream`

改动清单：[rag-input-output-guard-changelog.md](./rag-input-output-guard-changelog.md)

### 5.1 前端 → 服务端

```json
{
  "question": "不要把整篇文档塞进 prompt 冒充 RAG",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "model": "..."
}
```

- `question` = 当前问句（单独字段）
- `history` = **不含**当前问句的 prior 对话

### 5.2 buildRagPrompt 后（一次 LLM 调用）

检索经 toolGuard 通过且判空通过后：

```
[
  {
    role: "system",
    content: RAG_SYSTEM_PROMPT + "\n\n## 资料\n\n" + [1]...[2]... chunk 原文
  },
  ...history 里最近 6 条 user/assistant...,
  { role: "user", content: question }
]
```

- **独立 system**：不用 chat.ts 那份工具 system
- **不把天气等业务 tools 交给模型**；检索本身在服务端按 `searchDocs` 过 ToolGuard
- 一次 `completeRagMessages` → 整段答案经 SSE `delta` 推一次

### 5.3 SSE 回前端（顺序）

```
injection_detected? → tool_call → tool_result → output_leak_blocked?
→ rag_meta{ empty, hits, … } → delta(answer) → usage? → [DONE]
```

`rag_meta.hits` → RagHitPanel；`delta` → assistant 气泡；过程事件 → ToolTracePanel。

---

## 五b、链路 D：`POST /api/chat/plan`（Plan-and-Execute）

文件：`server/routes/chatPlan.ts` → `server/plan-execute/graph.ts` → `runPlanGraph`

这条链路的要点和前三条**根本不同**：它不把长 chat 史塞给模型，而是把一次任务拆成
「规划 → 逐步执行 → 终答」三段独立 LLM 调用。

### 五b.1 前端 → 服务端

```json
{
  "messages": [
    { "role": "user", "content": "查一下广州天气，再帮我算个行程" }
  ],
  "model": "deepseek-chat",
  "mode": "auto",
  "searchDocs": false
}
```

- `messages` 只用于**路由判定**和抽取任务目标，不整段进模型上下文
- `mode`：`auto`（按分类器自动选 ReAct 或计划）/ `react`（强制 ReAct）/ `plan`（强制计划）
- `searchDocs=true` 时，**计划里必须出现检索步骤**，否则判 `invalid_plan`

### 五b.2 规则路由（不进 LLM）

`server/plan-execute/classify.ts` → `classifyTask` 产出 `reasonCode`：

```
explicit_react / explicit_plan / research_then_produce / sequential_keywords
artifact_request / multi_capability / single_step / too_ambiguous
```

- `single_step` / `too_ambiguous` / `explicit_react` → **不调 Planner**，直接回退 ReAct
- 其余 → 进入 Planner

### 五b.3 发给 LLM 的 messages（三段各自独立）

| 阶段 | messages 形状 | tools |
|------|---------------|-------|
| 规划 | `[system(计划提示词), user(问句)]` | 无 |
| 单步执行 | `[system(单步提示词), user(目标 + 当前步 + 已完成摘要)]` | **本步白名单，≤ 3 个** |
| 最终回答 | `[system(终答提示词), user(已完成步骤摘要)]` | 无 |

没有「一条长 chat 史」；每次调用都是自包含的短期上下文。

### 五b.4 SSE 回前端（顺序）

```
plan_route → plan_created → plan_step_started → plan_step_done
→（可选 plan_replanned）→ plan_step_failed?
→ plan_finished → delta → usage → [DONE]
```

- `plan_*` 事件 → `PlanTimeline`（计划 + 每步状态，只在内存，不写 localStorage）
- `tool_call` / `pending_confirm` 等工具事件 → `ToolTracePanel`（与单 Agent 同形状，直接透传）
- `plan_fallback` → 只退**一次** ReAct，之后不再回退

---

## 六、四种链路对比（messages 视角）

| | `/api/chat` | `/api/chat/multi` | `/api/rag/chat` | `/api/chat/plan` |
|--|-------------|-------------------|-----------------|-----------------|
| 前端 history | user/assistant | user/assistant（服务端 mostly 忽略） | prior user/assistant + question | user/assistant（只用于判定与目标） |
| system 谁拼 | buildContext（budget）/ clipMessages（legacy）+ chat.ts | 各节点各自 system | rag/prompt.ts RAG_SYSTEM | plan-execute/prompts.ts（规划 / 单步 / 终答 三套） |
| 知识库资料放哪 | 追加到 system（prefetch，语义 C） | kb Worker 调 searchDocs（勾选 → forceKbSearch） | 追加到 system（## 资料） | 计划里必须有 searchDocs 步骤（开启知识库时） |
| tool 角色 | assistant+tool_calls + tool | Worker 内部同上 | 服务端检索按 searchDocs 过 Guard（模型无 tools） | 每步只挂本步白名单工具（≤ 3） |
| 多轮 LLM | ReAct 1~5 次 | Supervisor+Workers+Aggregate | 通常 1 次 | 规划 1 + 每步 ≤ 2 + Re-plan ≤ 1 + 终答 1（预算 15） |
| 响应格式 | SSE | SSE | SSE | SSE（计划事件 + 工具事件） |
| Input/Output Guard | detectInjection + detectLeakage（SSE） | 同左 | 同左 | 复用工具 Guard；计划失败按错误码终止 |
| Tool Guard | applyToolCalls | runToolSafely | validateToolCall(searchDocs) | 复用 applyToolCalls + ConfirmSession |
| LangSmith | ✅ chat-request / chat-prefetch / chat-llm | ✅ multi-request（勾选搜索 → forceKbSearch） | ✅ rag-request | ✅ plan-request / plan-planner |
| 过程可见 | 工具面板 | 工具面板 | 工具面板 + 命中面板 | 工具面板 + **计划时间线** |

---

## 七、Mermaid 总览

```mermaid
flowchart TB
  subgraph FE[前端 useChat]
    U1[user 气泡]
    A1[assistant 气泡]
    LS[(localStorage 仅 user/assistant)]
  end

  subgraph API[Express index.ts]
    CHAT[/api/chat/]
    MULTI[/api/chat/multi/]
    RAG[/api/rag/chat/]
    PLAN[/api/chat/plan/]
  end

  U1 --> LS
  A1 --> LS
  LS -->|messages 无 system| CHAT
  LS -->|messages 无 system| MULTI
  LS -->|question + history| RAG
  LS -->|messages 无 system + mode| PLAN

  subgraph CHAT_FLOW[单 Agent messages 拼装]
    CLIP[buildContext: system + 摘要 + 最近窗口]
    PREF[prefetch 可选: system += 检索块]
    REACT[ReAct: +assistant/tool +assistant 最终]
    CLIP --> PREF --> REACT
  end

  CHAT --> CLIP
  REACT --> SSE[SSE delta + trace + usage]

  subgraph MULTI_FLOW[多 Agent]
    LAST[只取最后 user]
    SUP[Supervisor system+user]
    WRK[Workers 各自 system+user+tools]
    AGG[Aggregate system+user]
    LAST --> SUP --> WRK --> AGG
  end

  MULTI --> LAST
  AGG --> SSE

  subgraph RAG_FLOW[资料问答]
    RET[retrieve 判空]
    BP[buildRagPrompt: system+资料+history+user]
    LLM1[completeRagMessages 一次]
    RET --> BP --> LLM1
  end

  RAG --> RET
  LLM1 --> JSON[JSON answer+hits+usage]

  subgraph PLAN_FLOW[Plan-and-Execute]
    CLS["classifyTask 规则路由"]
    PL["Planner: system+user 产出计划"]
    EXE["Executor: 顺序执行 每步 ≤3 工具"]
    RP["Re-plan ≤1 受控改写"]
    FIN["终答: system+已完成摘要"]
    CLS --> PL --> EXE --> RP --> FIN
  end

  PLAN --> CLS
  FIN --> PSSE["SSE plan_* + tool_* + delta"]
```

---

## 八、相关源码索引

| 话题 | 文件 |
|------|------|
| 前端发请求 | `src/composables/useChat.ts`, `src/api/chat.ts`, `src/api/rag.ts` |
| 预算 + 摘要 + 窗口 + 注入 system | `server/context/buildContext.ts`, `server/chat.ts` |
| legacy 截断（兼容保留） | `server/clipMessages.ts` |
| 搜索知识库 prefetch | `server/react/prefetchSearchDocs.ts` |
| ReAct + tool 回填 | `server/react/runConversation.ts`, `applyToolCalls.ts` |
| 多 Agent | `server/multi-agent/graph.ts` |
| RAG prompt | `server/rag/prompt.ts`, `server/rag/answer.ts` |
| 回答风格收敛 | `server/answer-style/knowledgeAnswer.ts` |
| Plan-and-Execute | `server/plan-execute/`, `server/routes/chatPlan.ts` |
| 计划时间线 UI | `src/components/PlanTimeline.vue` |
| 计划架构说明 | `docs/plan-and-execute.md` |
| 长上下文管理 | `docs/long-context.md` |
