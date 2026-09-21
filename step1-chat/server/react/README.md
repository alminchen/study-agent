# server/react/ — 单 Agent ReAct 循环

> 所属学习阶段：**阶段 4 · 真正的 Agent**
> 学习计划文档：`stage4-react-learning-plan.md`、`stage4-react-process-learning-plan.md`

## 模块职责

实现单 Agent 的 ReAct（Reason + Act）循环：问模型 → 执行工具 → 再问模型 → 最终回复。使用 LangGraph 状态图编排。

## 文件说明

| 文件 | 职责 |
|------|------|
| `runConversation.ts` | LangGraph 图主文件：askModel → applyTools → reply |
| `complete.ts` | 问模型一次（带 tools schema 的 chat completion） |
| `applyToolCalls.ts` | 执行模型返回的 tool_calls，结果回填 messages |
| `prefetchSearchDocs.ts` | 勾选「搜索知识库」时强制预检索，注入 system prompt |
| `toolFailure.ts` | 连续失败计数器（同一工具连续 N 次失败后熔断） |
| `types.ts` | 类型定义（ProviderMessage、ReactLoopOptions 等） |

## 数据流

```
用户消息 → buildSystemPrompt → clipMessages
  → prefetchSearchDocs（可选）
  → LangGraph 图：askModel ←→ applyTools → reply
  → SSE 输出 delta + trace events
```

## API 端点

`POST /api/chat`（`server/index.ts`）
