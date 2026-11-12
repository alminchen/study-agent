# server/react/ — 单 Agent ReAct 循环

> 所属学习阶段：**阶段 4 · 真正的 Agent**
> 学习计划文档：`stage4-react-learning-plan.md`、`stage4-react-process-learning-plan.md`

## 模块职责

实现单 Agent 的 ReAct（Reason + Act）循环：问模型 → 执行工具 → 再问模型 → 最终回复。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `runConversation.ts` | LangGraph 状态图主文件：askModel → applyTools → reply |
| `runConversation.forLoop.ts` | 不用 LangGraph 的纯 for 循环实现，作对照基线 |
| `complete.ts` | 问模型一次（带 tools schema 的 chat completion），处理 thinking 和 usage |
| `applyToolCalls.ts` | 执行模型返回的 tool_calls，结果回填 messages |
| `prefetchSearchDocs.ts` | 勾选「搜索知识库」时强制预检索并注入 system prompt |
| `confirmGate.ts` | 人工确认闸门 `ConfirmSession`：wait / resolve / dispose |
| `toolFailure.ts` | 连续失败计数器，同一工具连续失败达阈值后熔断 |
| `types.ts` | 类型定义：`ProviderMessage`、`ReactLoopOptions`、`ToolTraceHandler` 等 |

## 数据流

```text
用户消息 → buildSystemPrompt → clipMessages
  → prefetchSearchDocs（可选）
  → LangGraph 图：askModel ←→ applyTools → reply
  → SSE 输出 delta + trace events
```

## 两套循环实现的区别

`runConversation.ts` 用 LangGraph 状态图，`runConversation.forLoop.ts` 是纯 for 循环。
两者行为一致，后者作为对照基线：**换编排框架不应该改变对外行为**，
这是判断「LangGraph 有没有帮上忙」的依据。

## 人工确认闸门

有后果的工具不能在模型一返回 `tool_calls` 就立刻执行。
时序：

```text
applyToolCalls              浏览器              POST /api/chat/confirm
     │  onTrace(pending_confirm) │                    │
     │ ────────────────────────►│ 展示参数 + 允许/拒绝  │
     │  await wait(toolCallId)  │                    │
     │        （卡住）            │  用户点击           │
     │                          │───────────────────►│
     │◄───────────────────────── resolve(allow|deny)  │
     │  继续 run 或回填拒绝        │                    │
```

关键约定：

- 一次 HTTP 聊天请求 ↔ 一个 `ConfirmSession`（`confirmId`）
- 一轮里每个需确认的 `tool_call` 用自己的 `toolCallId` 做 wait/resolve 键
- 请求结束必须 `dispose()`，否则 Promise 一直挂着占内存
- `getConfirmSession` 只查「聊天请求已经 new 出来并登记过」的那份，不凭空造对象

## 工具熔断

`toolFailure.ts` 里 `MAX_CONSECUTIVE_TOOL_FAILURES = 2`：
同一工具连续失败两次就不再继续试，把错误回填给模型让它自己换路，
避免模型在同一个失败工具上无限循环。

## API 端点

`POST /api/chat`（`server/routes/chat.ts`）

## 相关文档

- `docs/human-confirm-changelog.md`：人工确认设计记录
- `server/chat.ts`：system 拼装、上下文、Guard、记忆的编排
