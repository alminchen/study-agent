# study-ai

`study-ai` 是一套以前端开发者视角整理并实践的 AI Agent 学习仓库。内容从 LLM 流式聊天、Tool Calling 和 RAG，逐步扩展到 ReAct、人工确认、多 Agent、MCP、Tracing、Evals、安全防护、错误恢复与 Token 成本控制。

仓库中的可运行项目位于 [`step1-chat/`](step1-chat/README.md)，根目录的 Markdown 文档记录学习路线、阶段计划、实现说明和验收记录。建议先阅读总计划，再按阶段进入对应文档。

## 快速入口

| 文档 | 说明 |
| --- | --- |
| [learning-plan.md](learning-plan.md) | 总学习计划、当前进度、阶段任务与下一步顺序 |
| [frontend-ai-agent-learning-roadmap.merged.md](frontend-ai-agent-learning-roadmap.merged.md) | 融合后的前端开发者 AI Agent 学习路线 |
| [step1-chat/README.md](step1-chat/README.md) | 可运行项目的完整说明、快速开始、API、SSE 和排障 |
| [step1-chat/docs/flows-index.md](step1-chat/docs/flows-index.md) | 单 Agent、多 Agent、RAG、Guard、Tracing 等流程索引 |
| [step1-chat/docs/project-messages-flow.md](step1-chat/docs/project-messages-flow.md) | 三条链路的 messages 拼接、工具调用和上下文组织 |
| [advanced-learning-plan.md](advanced-learning-plan.md) | 主线完成后的进阶主题，如结构化流式输出、Memory 和 Vision |
| [post-learning-optimization-plan.md](post-learning-optimization-plan.md) | 学习完成后的性能优化、重构与清理计划 |

## 快速开始

项目需要 Node.js 20 或更高版本。单 Agent 普通聊天可以在 Mock 模式下体验；多 Agent 和 RAG 需要真实模型 API Key。

```bash
cd step1-chat
npm install
npm run dev
```

默认地址：

- 前端：<http://localhost:5173>
- API：<http://127.0.0.1:8787>

完整环境变量、Mock 模式、知识库初始化和脚本说明见 [step1-chat/README.md](step1-chat/README.md)。

## 学习路线

| 文档 | 说明 |
| --- | --- |
| [frontend-ai-agent-learning-roadmap.frontend.md](frontend-ai-agent-learning-roadmap.frontend.md) | 前端视角的学习边界、技术选型、30 天与 90 天路线 |
| [learning-plan.md](learning-plan.md) | 主线清单、进度追踪、阶段验收与项目方向 |
| [advanced-learning-plan.md](advanced-learning-plan.md) | 主线后的进阶能力与候选练习 |
| [dynamic-kb-learning-plan.md](dynamic-kb-learning-plan.md) | 动态知识库：上传、切片、异步入库、分类和下架 |
| [rag-query-intent-rewrite-learning-plan.md](rag-query-intent-rewrite-learning-plan.md) | 检索前问句增强：意图、扩写、路由、Multi-Query 和 HyDE |
| [post-learning-optimization-plan.md](post-learning-optimization-plan.md) | 后置优化计划、P0-P2 顺序和明确的非目标 |
| [tool-calling-demo.md](tool-calling-demo.md) | 从协议消息到完整代码的 Tool Calling 独立示例 |

## 阶段 3：RAG

| 文档 | 说明 |
| --- | --- |
| [stage3-rag-prep-install-plan.md](stage3-rag-prep-install-plan.md) | RAG 编码前的安装、模型和服务准备清单 |
| [stage3-rag-execution-plan.md](stage3-rag-execution-plan.md) | 切分、Embedding、召回、重排、上下文注入的完整执行计划 |
| [stage3-rag-notes.md](stage3-rag-notes.md) | RAG 学习注意事项、常见误区和动手前冻结的决定 |

## 阶段 4：ReAct 与工具

| 文档 | 说明 |
| --- | --- |
| [stage4-react-learning-plan.md](stage4-react-learning-plan.md) | ReAct 概念、循环实现、难点和测试点 |
| [stage4-react-process-learning-plan.md](stage4-react-process-learning-plan.md) | LangGraph 状态图与执行过程面板 |
| [stage4-tool-failure-learning-plan.md](stage4-tool-failure-learning-plan.md) | 参数错误、未知工具、业务失败和连续失败上限 |
| [stage4-kb-search-tool-learning-plan.md](stage4-kb-search-tool-learning-plan.md) | 将知识库检索封装为可调用工具 |
| [stage4-human-confirm-overview.md](stage4-human-confirm-overview.md) | 有后果操作的人工确认课程说明 |
| [stage4-human-confirm-learning-plan.md](stage4-human-confirm-learning-plan.md) | 人工确认的学习范围、动手步骤和测试点 |

## 阶段 5：工程化与差异化

| 文档 | 说明 |
| --- | --- |
| [stage5-mcp-learning-plan.md](stage5-mcp-learning-plan.md) | MCP 基础概念、用途、难点和学习路径 |
| [stage5-mcp-hands-on.md](stage5-mcp-hands-on.md) | MCP Server、Client 和工具暴露的动手步骤 |
| [stage5-tracing-learning-plan.md](stage5-tracing-learning-plan.md) | Tracing、LangSmith 与可观测性基础 |
| [stage5-tracing-hands-on.md](stage5-tracing-hands-on.md) | Tracing 配置、运行和 LangSmith 验收 |
| [stage5-evals-learning-plan.md](stage5-evals-learning-plan.md) | 数据集、Runner、判分方式和 Evals 学习路径 |
| [stage5-evals-hands-on.md](stage5-evals-hands-on.md) | Evals 最小字段、样例选择和接现网 Runner |
| [stage5-resilience-learning-plan.md](stage5-resilience-learning-plan.md) | 超时、重试、限流、降级和错误恢复 |
| [stage5-prompt-injection-learning-plan.md](stage5-prompt-injection-learning-plan.md) | Prompt Injection 的基础防护和验收标准 |
| [stage5-multi-agent-learning-plan.md](stage5-multi-agent-learning-plan.md) | Supervisor-Worker 多 Agent 学习计划 |
| [stage5-multi-agent-hands-on.md](stage5-multi-agent-hands-on.md) | 多 Agent 概念笔记、拓扑和动手步骤 |
| [stage5-multi-agent-human-confirm-learning-plan.md](stage5-multi-agent-human-confirm-learning-plan.md) | 多 Agent 接入人工确认的文件改动清单 |
| [stage5-token-cost-learning-plan.md](stage5-token-cost-learning-plan.md) | Token 统计、成本归因和控制策略 |
| [stage5-token-cost-hands-on.md](stage5-token-cost-hands-on.md) | Token 用量、成本展示和对比实验 |

## 项目实现方案

| 文档 | 说明 |
| --- | --- |
| [frontend-bug-analysis-implementation.md](frontend-bug-analysis-implementation.md) | 基于现有聊天项目实现 Bug 分析 Demo 的精简方案 |
| [frontend-dev-assistant-implementation.md](frontend-dev-assistant-implementation.md) | 前端开发助手：需求转代码的范围、架构和分期实施 |

## step1-chat 项目文档

| 文档 | 说明 |
| --- | --- |
| [step1-chat/README.md](step1-chat/README.md) | 项目总览、快速开始、环境变量、页面使用和 API |
| [step1-chat/sequence-diagrams.md](step1-chat/sequence-diagrams.md) | 各模块 Mermaid 时序图源码 |
| [step1-chat/docs/flows-index.md](step1-chat/docs/flows-index.md) | 流程 SVG、HTML 和对应实现文档索引 |
| [step1-chat/docs/project-messages-flow.md](step1-chat/docs/project-messages-flow.md) | 系统提示词、历史消息和三条请求链路的消息拼接 |
| [step1-chat/docs/structured-output.md](step1-chat/docs/structured-output.md) | 流式结构化输出：稳定快照、最终 Schema、错误终态和前端渲染 |
| [step1-chat/docs/plan-and-execute.md](step1-chat/docs/plan-and-execute.md) | Plan-and-Execute：规则路由、计划执行、受控 Re-plan 和人工确认边界 |
| [step1-chat/docs/long-context.md](step1-chat/docs/long-context.md) | 长上下文管理：Token 预算、结构化摘要、降级和压缩提示 |
| [step1-chat/docs/dynamic-tool-discovery.md](step1-chat/docs/dynamic-tool-discovery.md) | 工具静态注册与动态发现方案 |
| [step1-chat/docs/resilience-failure-map.md](step1-chat/docs/resilience-failure-map.md) | 失败地图、恢复策略和降级行为 |
| [step1-chat/docs/llm-judge.md](step1-chat/docs/llm-judge.md) | LLM-as-Judge 语义判定：三档模式、判定口径与评测 |
| [step1-chat/docs/reflection.md](step1-chat/docs/reflection.md) | Reflection 自我评估：三档模式、准入条件与降级 |
| [step1-chat/docs/memory.md](step1-chat/docs/memory.md) | 跨会话记忆：数据模型、选型对比与隐私设计 |
| [step1-chat/docs/memory-chain-integration.md](step1-chat/docs/memory-chain-integration.md) | 记忆接入四条链路的集成说明 |
| [step1-chat/docs/vision.md](step1-chat/docs/vision.md) | 图片输入：模型能力判定、图片上限与当前边界 |
| [step1-chat/docs/human-confirm-changelog.md](step1-chat/docs/human-confirm-changelog.md) | 单 Agent 人工确认的修改记录和回归表 |
| [step1-chat/docs/multi-agent-human-confirm-changelog.md](step1-chat/docs/multi-agent-human-confirm-changelog.md) | 多 Agent 人工确认的修改记录 |
| [step1-chat/docs/rag-input-output-guard-changelog.md](step1-chat/docs/rag-input-output-guard-changelog.md) | RAG Guard、SSE Trace 和 LangSmith 修改记录 |
| [step1-chat/docs/rag-query-enhance-notes.md](step1-chat/docs/rag-query-enhance-notes.md) | 检索前问句增强的开关、脚本和验收方法 |
| [step1-chat/docs/post-learning-optimization-changelog.md](step1-chat/docs/post-learning-optimization-changelog.md) | 后续优化落地记录 |

### 模块说明

| 文档 | 说明 |
| --- | --- |
| [step1-chat/server/README.md](step1-chat/server/README.md) | 服务端分层总览与模块地图 |
| [step1-chat/src/README.md](step1-chat/src/README.md) | 前端分层总览、组件与状态中枢 |
| [step1-chat/scripts/README.md](step1-chat/scripts/README.md) | 本地验证脚本清单与用法 |
| [step1-chat/evals/README.md](step1-chat/evals/README.md) | 评测数据集与两套判分体系 |
| [step1-chat/server/routes/README.md](step1-chat/server/routes/README.md) | HTTP 路由拆分与 SSE 端点 |
| [step1-chat/server/react/README.md](step1-chat/server/react/README.md) | 单 Agent ReAct 循环 |
| [step1-chat/server/multi-agent/README.md](step1-chat/server/multi-agent/README.md) | Supervisor-Worker 多 Agent 编排 |
| [step1-chat/server/rag/README.md](step1-chat/server/rag/README.md) | 可解释 RAG 检索增强链路 |
| [step1-chat/server/tools/README.md](step1-chat/server/tools/README.md) | 工具定义、参数校验与执行 |
| [step1-chat/server/guard/README.md](step1-chat/server/guard/README.md) | 输入、工具和输出防护 |
| [step1-chat/server/mcp/README.md](step1-chat/server/mcp/README.md) | MCP Server 与 stdio 工具暴露 |
| [step1-chat/server/tracing/README.md](step1-chat/server/tracing/README.md) | LangSmith Tracing 接入 |
| [step1-chat/server/usage/README.md](step1-chat/server/usage/README.md) | Token 统计、成本估算与用量接口 |
| [step1-chat/server/structured/README.md](step1-chat/server/structured/README.md) | 结构化输出的协议与状态机 |
| [step1-chat/server/plan-execute/README.md](step1-chat/server/plan-execute/README.md) | Planner、Executor 与 Re-plan |
| [step1-chat/server/reflection/README.md](step1-chat/server/reflection/README.md) | 自我评估的评分与重写 |
| [step1-chat/server/memory/README.md](step1-chat/server/memory/README.md) | 跨会话记忆的数据模型与链路 |
| [step1-chat/server/context/README.md](step1-chat/server/context/README.md) | Token 预算、上下文裁剪与摘要 |
| [step1-chat/server/rag/queryEnhance/README.md](step1-chat/server/rag/queryEnhance/README.md) | 检索前查询增强五个单元 |
| [step1-chat/server/answer-style/README.md](step1-chat/server/answer-style/README.md) | 知识库回答风格收敛 |
| [step1-chat/server/vision/README.md](step1-chat/server/vision/README.md) | 图片输入的服务端校验与协议转换 |
| [step1-chat/src/vision/README.md](step1-chat/src/vision/README.md) | 前端图片压缩与快速校验 |
| [step1-chat/server/mock/README.md](step1-chat/server/mock/README.md) | 无 Key 时的假流式回复 |

### 教学样例

| 文档 | 说明 |
| --- | --- |
| [step1-chat/docs-sample/stage3-rag-notes.md](step1-chat/docs-sample/stage3-rag-notes.md) | 用于 RAG 入库和检索练习的样例笔记 |
| [step1-chat/docs-sample/stage5-hr-policy-notes.md](step1-chat/docs-sample/stage5-hr-policy-notes.md) | 用于多库路由和制度问答练习的样例资料 |

## 仓库结构

```text
study-ai/
├── README.md
├── learning-plan.md
├── frontend-ai-agent-learning-roadmap.*.md
├── stage3-*.md
├── stage4-*.md
├── stage5-*.md
├── frontend-*-implementation.md
└── step1-chat/
    ├── README.md
    ├── server/
    ├── src/
    ├── docs/
    ├── docs-sample/
    ├── evals/
    └── scripts/
```

## 使用建议

1. 先阅读 [learning-plan.md](learning-plan.md)，确认当前进度和下一步。
2. 在对应阶段的计划文档中完成概念学习，再进入动手文档。
3. 从 [step1-chat/README.md](step1-chat/README.md) 启动项目，结合 [flows-index.md](step1-chat/docs/flows-index.md) 对照代码。
4. 修改功能后，使用阶段文档中的测试点、Evals 或回归表验收。

本项目主要用于本地学习和方案验证，不是生产级平台。密钥、向量库、会话、人工确认状态和使用量数据均按本地开发场景设计。
