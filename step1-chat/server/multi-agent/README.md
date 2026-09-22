# server/multi-agent/ — 多 Agent 编排（Supervisor-Worker）

> 所属学习阶段：**阶段 5 · 多 Agent 编排（已结）** · **人工确认已接入（方案 A）**  
> 学习计划：`stage5-multi-agent-learning-plan.md` · 动手：`stage5-multi-agent-hands-on.md`  
> 确认改动记录：`docs/multi-agent-human-confirm-changelog.md` · 流程图：`docs/multi-agent-human-confirm-flow.svg`  
> Evals：`evals/dataset-multi.json` · `npm run eval:multi`

## 模块职责

将单 Agent ReAct 扩展为多 Agent 协作：**Supervisor 路由 → Worker 并行 → Aggregate 汇总**。  
有后果工具（如 `draft_message`）走 **actionWorker + runToolSafely 人工确认**，复用单 Agent 的 `ConfirmSession` 与 `POST /api/chat/confirm`。

## 文件说明

| 文件 | 职责 |
|------|------|
| `llm.ts` | 公共 `callLLM`：统一 fetch / 解析 / usage / LangSmith `multi-llm` |
| `supervisor.ts` | 一次 LLM + `route` tool → `RouteDecision`（含 `action`） |
| `workers/realtimeWorker.ts` | 天气+时间；工具 `getWeather` / `getCurrentTime` |
| `workers/kbWorker.ts` | 知识库；工具 `searchDocs` |
| `workers/actionWorker.ts` | **起草/发送类**；工具仅 `draft_message`（需人工确认） |
| `workers/generalWorker.ts` | 兜底闲聊；无工具 |
| `workers/types.ts` | `WorkerContext`：含可选 `confirmSession` / `onTrace` |
| `workers/index.ts` | `name → run` 注册表（含 `action`） |
| `runToolSafely.ts` | Guard →（可选）确认 → `runToolWithTracing`；对齐单 Agent |
| `aggregate.ts` | 汇总；单 Worker 透传；失败拼接降级；`outputGuard` |
| `graph.ts` | LangGraph + LangSmith 节点 span（supervisor/workers/aggregate） |

入口路由：[`server/routes/chatMulti.ts`](../routes/chatMulti.ts)（`ConfirmSession` + `runMultiRequestWithTracing` 根 span，invoke **进行中**写 SSE）。

### LangSmith span 树（`LANGCHAIN_TRACING_V2=true`）

```
multi-request
  ├─ multi-supervisor → multi-llm(role=supervisor)
  ├─ multi-workers
  │    └─ multi-worker(name) → multi-llm + tool
  └─ multi-aggregate → multi-llm(role=aggregate)  # 单 Worker 透传时可能无 LLM
```

---

## 架构要点（研读笔记）

### Supervisor 路由

- **system**：只描述 Worker 能力边界 +「可多选 / 不确定选 general / 起草选 action / 必须调 route」
- **结构化输出**：不靠自由文本，强制 Function Calling `route` 工具
- **Worker 白名单**：`realtime` | `kb` | `action` | `general`
- **fallback**：LLM 失败 / 未调 route / JSON 坏 / 非法 worker 名 → 一律兜底 `general`
- **产出**：`{ workers: [{ name, task }] }`，`task` 是分给该 Worker 的子问句

### Worker mini ReAct

- 各自独立 `messages`（system + task），**不共享**主对话长历史
- **工具隔离**：只把本 Worker 需要的 schema 传给模型
- Realtime / KB / Action：最多 `MAX_TURNS=3`；经 `runToolSafely` 再执行
- General：一次 `callLLM`，无 tools
- 失败：`WorkerResult.error=true`，Aggregate 会如实告知

### 人工确认（与单 Agent 对齐）

```
chatMulti: new ConfirmSession()
  → compileMultiAgentGraph({ confirmSession, onTrace, writeSse })
  → workersNode 下传 ctx
  → actionWorker → runToolSafely
       → onTrace(pending_confirm)  // 中途 SSE，连接仍开着
       → await confirmSession.wait(...)
       → 前端 POST /api/chat/confirm → resolve(allow|deny)
       → allow: tool.run / deny: { error: 用户拒绝 }
  → finally dispose()
```

| 要点 | 说明 |
|------|------|
| **谁创建 Session** | `chatMulti.ts`，与单 Agent `chat.ts` 同一套 `confirmGate.ts` |
| **谁解开 wait** | 共用 `POST /api/chat/confirm`（`chatConfirm.ts` **不改**） |
| **闸门位置** | `runToolSafely`（对应单 Agent 的 `applyToolCalls` / `runWithOptionalConfirm`） |
| **谁挂需确认工具** | **actionWorker** 只挂 `draft_message`；realtime/kb 透传 session，自身工具一般不需确认 |
| **中途 SSE（硬约束）** | `pending_confirm` / `confirm_resolved` / `tool_*` / `supervisor_route` / `worker_done` 必须在 `graph.invoke` **进行中**写出。若整图跑完再推，wait 期间前端收不到待确认事件 |
| **流程图** | [`docs/multi-agent-human-confirm-flow.svg`](../../docs/multi-agent-human-confirm-flow.svg) |

### Aggregate 策略

| 情况 | 行为 |
|------|------|
| 仅 1 个 Worker 且成功 | **透传** output，不再调 LLM（省一次） |
| 多个 Worker 或有错误 | 再调一次 LLM 整合成连贯回答 |
| Aggregate LLM 失败 | **降级拼接**各 Worker 文本 |
| 写出前 | `detectLeakage`（outputGuard） |

### LangGraph 状态与边

线性三节点（并行放在 `workersNode` 内 `Promise.all`，不用条件边枚举组合）：

```
START → supervisor → workers → aggregate → END
```

State 字段：`userMessage` / `apiKey` / …（入口只读）→ `routeDecision` → `workerResults` → `finalOutput`。

Token：同一 `UsageAccumulator`，source 分别为 `supervisor` / `worker` / `aggregate`。

图编译 options（请求级注入，不进 State）：`confirmSession` / `onTrace` / `writeSse` / `accumulator`。

### `callLLM` 设计意图

Supervisor、Worker、Aggregate 都要调模型；抽出公共层避免重复样板，并统一挂 `onUsage`。  
返回：`{ ok, status, content, toolCalls, usage }`。

### 与单 Agent 对比

| | 单 Agent `/api/chat` | 多 Agent `/api/chat/multi` |
|--|----------------------|----------------------------|
| 规划 | ReAct 模型自己边想边调 | Supervisor 先路由 |
| 工具可见性 | 本轮全部（可含 searchDocs） | 各 Worker 子集 |
| 并行 | 一轮内多 tool_calls（模型常串行） | Worker 级 `Promise.all` |
| 历史 | clipMessages 最近 N 条 | **当前只用最后一句 user** |
| 防护 | chat + applyToolCalls + reply | chatMulti + runToolSafely + aggregate |
| **人工确认** | `applyToolCalls` + Session | **`runToolSafely` + Session**（API 共用） |
| 过程事件 | `tool_call` / `tool_result` / `pending_confirm`… | 同上 + `supervisor_route` / `worker_done` |

共享：同一套 `server/tools/`、`confirmGate` / `chatConfirm`、usage、guard。

---

## 数据流

```
用户消息
  → chatMulti: ConfirmSession + writeSse/onTrace
  → supervisorRoute() → RouteDecision { workers: [{name, task}] }
       · 起草类 → action
  → workersNode() → Promise.all(...) → WorkerResult[]
       · action: runToolSafely 可能 await wait（中途 SSE pending_confirm）
  → aggregate() → finalOutput（已过 outputGuard）
  → delta / usage / [DONE] → dispose Session
```

## API

`POST /api/chat/multi` → [`server/routes/chatMulti.ts`](../routes/chatMulti.ts)

SSE（**invoke 进行中即可写出**）：

```
injection_detected?
  → supervisor_route
  →（若需确认）tool_call → pending_confirm → … → confirm_resolved → tool_result
  → worker_done × N
  → delta → usage → [DONE]
```

确认短请求（与单 Agent 共用）：`POST /api/chat/confirm` `{ confirmId, toolCallId, action }`。

前端：勾选「多 Agent」走本端点；勾选「搜索知识库」时 `searchDocs=true` → `forceKbSearch`，保证路由含 kb。

## Evals

```bash
npm run eval:multi
```

用例见 `evals/dataset-multi.json`：单路由（realtime / kb / general）、混合（weather+kb、time+kb）等。  
（确认路径目前以手测为主，见 changelog 手测清单。）

## 拓扑说明（本课范围）

- **已实现**：Supervisor-Worker（中心化）；人工确认（actionWorker + 共用 ConfirmSession）
- **未实现（了解即可）**：Peer-to-Peer；需要时再开进阶
