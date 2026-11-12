# server/tracing/ — 可观测性（LangSmith Tracing）

> 所属学习阶段：**阶段 5 · Tracing**
> 学习计划文档：`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`

## 模块职责

把各条链路的执行过程上报到 LangSmith，在网页上看 span 树、耗时、输入输出、错误。

**这不是给用户看的。** 页面上的 `ToolTracePanel` 走 SSE 的 `onTrace`，
和这里的 LangSmith 追踪是两套东西，职责分开。

## 为什么不用 LangChain 自带的回调

我们的 LLM 调用在 `react/complete.ts` 里是手写 `fetch`
（OpenAI 兼容接口 + `reasoning_content` 思考模式），没走 `@langchain/openai` 的 ChatModel，
所以 `LangChainTracer` 不会自动包住每一次 HTTP。
这里用 langsmith 的 `traceable()` 在关键节点**手动**打 span。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `langsmith.ts` | 所有 trace 包装器与开关判断，单文件集中管理 |

## 开关

| 变量 | 作用 |
| --- | --- |
| `LANGCHAIN_TRACING_V2=true` | 开关；为 false 或未设时函数仍可调用，但不上报 |
| `LANGCHAIN_API_KEY` | 决定进哪个 Workspace |
| `LANGCHAIN_PROJECT` | trace 分组名，不是 Workspace 名，不存在会自动创建 |

`LANGSMITH_TRACING_V2`、`LANGCHAIN_TRACING`、`LANGSMITH_TRACING` 是等价别名。

## span 分组

| 链路 | 主 span | 子 span |
| --- | --- | --- |
| 单 Agent | `chat-request` | `chat-prefetch` / `chat-llm` / `tool` |
| 资料问答 | `rag-request` | `rag-retrieve` / `rag-llm` |
| 多 Agent | `multi-request` | `multi-supervisor` / `multi-workers` / `multi-worker` / `multi-aggregate` / `multi-llm` |
| 结构化输出 | `structured-request` | `structured-llm` |
| Plan | `plan-request` | `plan-planner` |

单 Agent 的 span 树长这样：

```text
chat-request          run_type: chain
  ├─ chat-prefetch    若勾选知识库
  ├─ chat-llm         turn=1（工具轮）
  ├─ tool             getWeather
  └─ chat-llm         turn=2…
```

## 两套 API 的分工

每组 trace 都提供两个东西：

- `traceXxx`：直接可挂的 `traceable` 函数
- `runXxxWithTracing`：包装器，负责「开关判断 + span 归属 + 错误兜底」

调用方用后者，不用自己判断开关。

## 刻意不上报的内容

| 不上报 | 原因 |
| --- | --- |
| 完整 `messages` 数组 | 太长，且含历史；`chat-llm` 只记 `message_count` |
| 任何 API Key | 泄漏即事故 |
| 超过 500 字的工具结果 JSON | 截断成 `result_preview` |
| 超过 120 字的用户问句 | 截断成 `user_preview` |

## 相关文档

- `docs/post-learning-optimization-changelog.md`：追踪改造记录
- `README.md`：环境变量章节
