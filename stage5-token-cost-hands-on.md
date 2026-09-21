# 阶段 5 · Token 统计与成本控制 · 动手计划

> 接 `stage5-token-cost-learning-plan.md`。在 `step1-chat` 里统计三条 LLM 链路的 token 用量，并做成本估算展示。

## 0. 前置

- 已配置 `LLM_API_KEY`，且 `MOCK_MODE` 未开启（Mock 无真实 usage）
- 理解「一次用户请求 ≠ 一次 LLM 调用」（见概念文档第 1 节）
- 本课 LLM 均为**非流式**，可直接读响应里的 `usage` 字段

## 1. 要交付什么（先记边界）

| 做                                             | 不做                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `server/usage/` 模块：解析、累加、单价、持久化 | 不做生产级计费/按用户扣费                   |
| 改造三条 LLM 封装层读 `usage`                  | 不改 Evals 逻辑                             |
| 请求结束 SSE/JSON 推送 `usage`                 | 不做完整「交付页 · 成本页」（本课做最小版） |
| `GET /api/usage` 查历史汇总                    | 不上 Prometheus/Grafana                     |
| 前端本轮 token + 估算成本展示                  | Mock 模式不伪造 token                       |

建议目录：

```
step1-chat/
  server/
    usage/
      types.ts
      parseUsage.ts
      pricing.ts
      accumulator.ts
      store.ts
      README.md
  src/
    api/usage.ts
    components/UsagePanel.vue
  data/
    usage-log.json          ← 运行时生成
```

## 2. 动手顺序

### 步骤 1：新建 `server/usage/`（约 30 分钟）

1. `parseUsage.ts` — 从 API JSON 提取 `prompt_tokens` / `completion_tokens` / `total_tokens`
2. `accumulator.ts` — `UsageAccumulator`：一次 HTTP 请求内多次 LLM 调用累加
3. `pricing.ts` — 按 model id 配置 USD/1M tokens 单价，`estimateCostUsd()`
4. `store.ts` — 追加记录到 `data/usage-log.json`，`getUsageSummary()`

### 步骤 2：改造 LLM 封装层（约 40 分钟）

| 文件                                  | 改动                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `server/react/complete.ts`            | 解析 usage，`requestCompletion` 返回 `{ choice, usage }`，调 `onUsage` |
| `server/react/types.ts`               | `ReactLoopOptions.onUsage`                                             |
| `server/react/runConversation.ts`     | 适配新返回值；LangSmith 路径仍拿 `choice`                              |
| `server/tracing/langsmith.ts`         | `traceAskModel` 内部 unwrap `choice`                                   |
| `server/multi-agent/llm.ts`           | `callLLM` 解析 usage，支持 `onUsage`                                   |
| `server/multi-agent/supervisor.ts`    | 传入 `onUsage`                                                         |
| `server/multi-agent/aggregate.ts`     | 传入 `onUsage`                                                         |
| `server/multi-agent/workers/types.ts` | `WorkerContext.onUsage`                                                |
| `server/multi-agent/workers/*.ts`     | 透传 `onUsage` 给 `callLLM`                                            |
| `server/multi-agent/graph.ts`         | `compileMultiAgentGraph({ accumulator })`                              |
| `server/rag/complete.ts`              | 返回 `{ content, usage, model }`                                       |
| `server/rag/answer.ts`                | `RagAnswer.usage`                                                      |

### 步骤 3：API 入口接线（约 20 分钟）

| 端点                   | 行为                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `POST /api/chat`       | 创建 Accumulator → 请求结束 SSE `{ type:"usage", ... }` → 写 store |
| `POST /api/chat/multi` | 同上                                                               |
| `POST /api/rag/chat`   | JSON 响应带 `usage` 字段                                           |
| `GET /api/usage`       | 返回汇总 + 最近记录                                                |
| `DELETE /api/usage`    | 清空（demo）                                                       |

### 步骤 4：前端展示（约 30 分钟）

1. `src/api/usage.ts` — `fetchUsageSummary()`
2. `src/types.ts` — `UsageSnapshot` 类型
3. `src/api/chat.ts` — 解析 SSE `type: "usage"` 事件
4. `src/composables/useChat.ts` — 存 `lastUsage`、`usageSummary`
5. `src/components/UsagePanel.vue` — 本轮 + 累计展示
6. `App.vue` — 挂载 UsagePanel

## 3. 自测清单

1. **单 Agent**：发「广州天气，顺便查查几点」→ SSE 结束前收到 `usage`，`llmCalls >= 2`
2. **多 Agent**：同一问句走 `/api/chat/multi` → usage 含 Supervisor + Worker + 可能的 Aggregate
3. **RAG 空结果**：问无关问题 → `calledModel: false`，usage 为 0 或缺失
4. **RAG 有命中**：问笔记相关问题 → 有 token 数
5. **GET /api/usage**：累计 requests 增加，recent 有记录
6. **Mock 模式**：不展示虚假 usage

## 4. 可选对比实验

同一问句分别走单 Agent / 多 Agent，记录：

| 模式            | totalTokens | llmCalls | estimatedCostUsd |
| --------------- | ----------- | -------- | ---------------- |
| /api/chat       |             |          |                  |
| /api/chat/multi |             |          |                  |

写进学习笔记：多 Agent 行为更清晰，但 token 通常更高。

## 5. 验收（对照 learning-plan 第 6 节）

- [x] 能说清 prompt/completion/total
- [x] 三条 API 都能统计 usage
- [x] 前端可见本轮消耗
- [x] `GET /api/usage` 可用

> **本课已结（学习者确认了解完成）。**

## 6. 下一课

下一项：`learning-plan.md` → **交付页（调试/日志/成本）+ eval 数据集**；可选先收尾多 Agent README/Evals。人工确认仍排在全部主线最后。
