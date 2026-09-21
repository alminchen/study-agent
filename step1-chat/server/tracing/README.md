# server/tracing/ — 可观测性（LangSmith Tracing）

> 所属学习阶段：**阶段 5 · Tracing**
> 学习计划文档：`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`

## 模块职责

为 Agent 的执行流程添加 LangSmith 链路追踪，在 LangSmith 面板上可视化每一步的耗时、输入输出、错误信息。

## 文件说明

| 文件 | 职责 |
|------|------|
| `langsmith.ts` | 封装 traceAskModel（包装 LLM 调用）和 traceToolRun（包装工具执行），控制 tracing 开关 |

## 开关控制

环境变量 `LANGCHAIN_TRACING_V2=true` 开启，`false` 或不设置则关闭。
