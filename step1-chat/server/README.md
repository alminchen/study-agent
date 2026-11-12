# server/ — 服务端总览

> 所属学习阶段：**阶段 3～进阶学习第 8 项**
> 本文是服务端地图；每个子目录有自己的 README，讲清那条链路的具体机制。
>
> 本文里的路径以 `server/` 为根，例如 `react/complete.ts` 即 `server/react/complete.ts`。

## 分层

```text
server/
├── index.ts            Express 入口：读 env、挂路由、listen
├── runtimeConfig.ts    运行时配置集中读取（所有环境变量在这里落地）
├── routes/             HTTP 层：一条端点一个文件
├── chat.ts             单轮对话内核：system 拼装 + 上下文 + Guard + 记忆 + ReAct 编排
├── context/            上下文预算与摘要（长上下文管理）
├── react/              单 Agent ReAct 循环（LangGraph 状态图）
├── multi-agent/        多 Agent：Supervisor → Worker → Aggregate
├── plan-execute/       Plan-and-Execute：Planner → Executor → Re-plan
├── structured/         Streaming 结构化输出：partial 解析 + 稳定快照
├── reflection/         自我评估：评分 + 重写
├── guard/              输入 / 工具 / 输出三道防护 + LLM Judge
├── memory/             跨会话长期记忆：抽取、合并、检索、注入
├── rag/                检索增强：切分、向量化、检索、重排、拼 prompt
├── answer-style/       知识库回答风格收敛（清洗检索元信息）
├── tools/              工具 schema 与本地实现
├── mcp/                MCP Server（对外暴露同一套工具）
├── vision/             图片输入：校验、能力判定、协议转换
├── mock/               无 Key 时的假流式回复
├── tracing/            LangSmith 链路追踪
└── usage/              Token 统计、估价与持久化
```

## 目录职责一览

| 目录 | 一句话职责 | 详细文档 |
| --- | --- | --- |
| `routes/` | 17 条 HTTP 端点，SSE 与 JSON 两种响应风格 | `routes/README.md` |
| `react/` | 单 Agent 的 ask → tool → ask 循环 | `react/README.md` |
| `multi-agent/` | 主管派发到多个 Worker 再汇总 | `multi-agent/README.md` |
| `plan-execute/` | 先出计划再逐步执行，可重规划 | `plan-execute/README.md` |
| `structured/` | 流式 JSON 的容错解析与快照 | `structured/README.md` |
| `reflection/` | 回头给答案打分，必要时重写 | `reflection/README.md` |
| `guard/` | 防注入、工具调用校验、输出审核 | `guard/README.md` |
| `memory/` | 跨会话记住用户偏好与事实 | `memory/README.md` |
| `context/` | 按 token 预算裁剪与摘要历史 | `context/README.md` |
| `rag/` | 检索 + 重排 + 拼 prompt + 生成 | `rag/README.md` |
| `tools/` | 工具注册表与具体工具实现 | `tools/README.md` |
| `mcp/` | 用标准协议对外提供工具 | `mcp/README.md` |
| `tracing/` | 把每一步打进 LangSmith | `tracing/README.md` |
| `usage/` | Token 与成本统计 | `usage/README.md` |
| `vision/` | 图片附件的校验与协议转换 | `vision/README.md` |
| `answer-style/` | 洗掉检索元信息，让回答像答案 | `answer-style/README.md` |
| `mock/` | 没 Key 也能把 SSE 链路跑通 | `mock/README.md` |

## 三条主链路的入口

所有聊天端点最终都汇到三个内核函数，区别只在编排方式：

| 链路 | 入口路由 | 内核 | 编排方式 |
| --- | --- | --- | --- |
| 单 Agent | `POST /api/chat` | `chat.ts` → `react/runConversation.ts` | 模型自己决定调不调工具 |
| 多 Agent | `POST /api/chat/multi` | `multi-agent/graph.ts` | Supervisor 派发 Worker，Aggregate 汇总 |
| Plan | `POST /api/chat/plan` | `plan-execute/graph.ts` | Planner 出步骤，Executor 执行，可 Re-plan |

资料问答 `POST /api/rag/chat` 是第四条，但它不进 ReAct：检索 → 判空 → 拼 prompt → 一次模型调用。

## 横切关注点

这几个能力不是某条链路独有，而是在多条链路上重复出现的横切逻辑：

- **防护**：`guard/` 的输入 Guard 在所有聊天链路最前面，输出 Guard 在最后面。
- **记忆**：`memory/bridge.ts` 是统一接入层，四条链路都从它拿记忆块、往它交抽取任务。
- **Tracing**：`tracing/langsmith.ts` 提供 `trace*` 包装器，各链路自己挑要包哪几步。
- **Usage**：`usage/accumulator.ts` 汇总各链路的 token 消耗，写进 `data/usage-log.json`。
- **配置**：所有环境变量只在 `runtimeConfig.ts` 落地一次，其他模块不再直接读 `process.env`。

## 相关文档

- `README.md`：项目总览、目录结构、HTTP API、npm scripts
- `docs/project-messages-flow.md`：消息组装与调用链
- `docs/flows-index.md`：全部流程图索引
