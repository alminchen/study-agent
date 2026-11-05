# server/usage/ — Token 统计与成本控制

> 所属学习阶段：**阶段 5 · Token 统计与成本控制（已结）**
> 学习计划：`stage5-token-cost-learning-plan.md` · 动手：`stage5-token-cost-hands-on.md`

## 模块职责

收集每次 API 请求中所有 LLM 调用的 token 用量，估算成本，持久化并提供查询接口。

## 文件说明

| 文件 | 职责 |
|------|------|
| `types.ts` | TokenUsage、UsageRecord、UsageSummary 类型 |
| `parseUsage.ts` | 从 chat/completions 响应解析 usage |
| `pricing.ts` | 按模型单价估算 USD 成本 |
| `accumulator.ts` | 请求级累加器（一次请求多次 LLM 调用） |
| `store.ts` | 内存 + `data/usage-log.json` 持久化 |

## 流程图（带方法名）

SVG 图（浏览器直接打开）：[`diagrams/usage-token.svg`](../../diagrams/usage-token.svg)

一次用户提问 = 一次 HTTP 请求 = **一个** `UsageAccumulator`。内部可能多次 LLM，每次 `record()`，请求结束再合成一条 `UsageRecord`。

### 总览：入口 → 累加 → 落盘 → 前端

```mermaid
flowchart TD
  U[用户发消息] --> E{哪条 API?}

  E -->|POST /api/chat| C["index.ts<br/>new UsageAccumulator()<br/>bindUsageCallback(acc, askModel)"]
  E -->|POST /api/chat/multi| M["index.ts<br/>new UsageAccumulator()<br/>compileMultiAgentGraph({ accumulator })"]
  E -->|POST /api/rag/chat| R["index.ts<br/>new UsageAccumulator()<br/>bindUsageCallback(acc, rag)"]
  E -->|POST /api/chat/structured| S["chatStructured.ts<br/>new UsageAccumulator()<br/>bindUsageCallback(acc, structured)"]

  C --> C1["createChatStream()<br/>chat.ts 透传 onUsage"]
  C1 --> C2["runConversation() askModel 节点<br/>requestCompletion()"]
  C2 --> LLM["react/complete.ts"]

  M --> M1["graph.ts onUsage(source)<br/>bindUsageCallback(acc, source)"]
  M1 --> M2["supervisorRoute / Worker.run / aggregate"]
  M2 --> LLM2["callLLM()"]

  R --> R1["answerFromDocs()"]
  R1 --> R2{检索判空?}
  R2 -->|空| SKIP["不调 LLM<br/>accumulator.isEmpty = true"]
  R2 -->|有资料| R3["completeRagMessages()"]
  R3 --> LLM3["rag/complete.ts"]

  S --> S1["streamStructuredCompletion()"]
  S1 --> LLM4["fetch /chat/completions<br/>stream: true"]

  LLM --> P["parseUsageFromResponse(data)"]
  LLM2 --> P
  LLM3 --> P
  LLM4 --> P

  P -->|null / 全 0| DROP[跳过 record]
  P -->|TokenUsage| CB["onUsage(usage, model)<br/>UsageAccumulator.record()"]

  CB --> ENDQ{请求结束}

  ENDQ -->|chat / chat/multi / chat/structured| W["writeUsageToStream()"]
  ENDQ -->|rag/chat| T["accumulator.toRecord('rag/chat')"]
  SKIP --> JSON["res.json({ ..., usage: null })"]

  W --> CHK{isEmpty?}
  CHK -->|是| NODATA[不写 store、不推 SSE usage]
  CHK -->|否| REC["toRecord(endpoint, defaultModel)"]

  T --> ISE{isEmpty?}
  ISE -->|是| JSON
  ISE -->|否| REC

  REC --> COST["estimatedCostUsd()<br/>内部调用 estimateCostUsd()"]
  COST --> STORE["appendUsageRecord(record)<br/>data/usage-log.json"]
  STORE --> SSE["SSE type=usage（chat / multi / rag / structured）"]
  SSE --> FE["useChat.lastUsage<br/>UsagePanel 本轮"]
  STORE --> GET["GET /api/usage<br/>getUsageSummary()"]
  GET --> FE2["UsagePanel 累计"]
```

### 单次 LLM 调用内部（解析层）

四条封装路径最终都走同一套：

```mermaid
flowchart LR
  FETCH["fetch /chat/completions"] --> JSON["response.json()"]
  JSON --> PARSE["parseUsageFromResponse()"]
  PARSE --> IF{usage 有效?}
  IF -->|否| NULL["return usage: null"]
  IF -->|是| CB["onUsage?.(usage, model)"]
  CB --> REC["UsageAccumulator.record(model, source, usage)"]
```

| 封装 | 方法 | source 标签 |
|------|------|-------------|
| `react/complete.ts` | `requestCompletion()` | `askModel` |
| `multi-agent/llm.ts` | `callLLM()` | `supervisor` / `worker` / `aggregate` |
| `rag/complete.ts` | `completeRagMessages()` | `rag` |
| `structured/complete.ts` | `streamStructuredCompletion()` | `structured` |

### 请求结束：合成一条记录

```mermaid
flowchart TD
  ACC[UsageAccumulator] --> MERGE["mergedUsage()<br/>mergeUsage() 相加 token"]
  ACC --> N[llmCalls]
  ACC --> MODEL["primaryModel(fallback)"]
  ACC --> USD["estimatedCostUsd()<br/>每次 estimateCostUsd(model, usage) 再相加"]
  MERGE --> SNAP[toSnapshot]
  N --> SNAP
  MODEL --> SNAP
  USD --> SNAP
  SNAP --> REC["toRecord()<br/>补 id + timestamp"]
  REC --> FILE["appendUsageRecord()<br/>store.persist()"]
```

### 查询与清空

```mermaid
flowchart LR
  GET["GET /api/usage"] --> SUM["getUsageSummary()"]
  DEL["DELETE /api/usage"] --> CLR["clearUsageRecords()"]
```

## API

- `GET /api/usage` — 汇总 + 最近记录
- `DELETE /api/usage` — 清空记录（demo）

## SSE 事件

请求结束前推送：

```json
{ "type": "usage", "endpoint": "chat", "totalTokens": 640, "llmCalls": 3, "estimatedCostUsd": 0.00012 }
```
