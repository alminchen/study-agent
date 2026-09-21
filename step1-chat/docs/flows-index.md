# 流程 SVG 索引

与 `human-confirm-flow.svg` 同风格的泳道流程图（含方法名与调用链）。

**浏览器一页浏览全部图：** [flows-index.html](./flows-index.html)

**学习计划 ↔ 项目方法级拓扑：** [project-topology.html](./project-topology.html)

| 图 | 说明 | 对应文档 |
|----|------|----------|
| [crosscutting-token-guard-trace-flow.svg](./crosscutting-token-guard-trace-flow.svg) | **横切流程图**：插入点 → Token 流 → Guard 三道门 → Trace 双通道 → 三端点对照 | usage/ · guard/ · tracing/ |
| [human-confirm-flow.svg](./human-confirm-flow.svg) | 单 Agent 人工确认完整泳道（wait/resolve/dispose）+ §6 横切归属 | [human-confirm-changelog.md](./human-confirm-changelog.md) |
| [multi-agent-human-confirm-flow.svg](./multi-agent-human-confirm-flow.svg) | **多 Agent 人工确认**：chatMulti → graph → actionWorker → runToolSafely → 共用 confirm API | [multi-agent-human-confirm-changelog.md](./multi-agent-human-confirm-changelog.md) |
| [chat-react-flow.svg](./chat-react-flow.svg) | 单 Agent ReAct + Accumulator / Guard / Trace | [project-messages-flow.md](./project-messages-flow.md) §三 |
| [chat-multi-flow.svg](./chat-multi-flow.svg) | 多 Agent + source 分桶计费 / Guard | [project-messages-flow.md](./project-messages-flow.md) §四 |
| [rag-chat-flow.svg](./rag-chat-flow.svg) | 召回→判空→重排→注入 + Token + **三道 Guard** + **SSE Trace** + **LangSmith** | [rag-input-output-guard-changelog.md](./rag-input-output-guard-changelog.md) · [project-messages-flow.md](./project-messages-flow.md) §五 |
| [rag-query-enhance-flow.svg](./rag-query-enhance-flow.svg) | **检索前问句增强**：意图/扩写/路由/Multi-Query/HyDE + env 开关 + meta 面板 | [rag-query-enhance-notes.md](./rag-query-enhance-notes.md) · [计划](../../rag-query-intent-rewrite-learning-plan.md) · 拓扑 [§6b](./project-topology.html#rag-enhance) |
| [messages-assembly-flow.svg](./messages-assembly-flow.svg) | messages 三层 × 三条链路总览 | [project-messages-flow.md](./project-messages-flow.md) |
| [resilience-failure-flow.svg](./resilience-failure-flow.svg) | 失败地图与恢复策略 | [resilience-failure-map.md](./resilience-failure-map.md) |
| [dynamic-tool-discovery-flow.svg](./dynamic-tool-discovery-flow.svg) | 工具静态注册 vs 动态发现 | [dynamic-tool-discovery.md](./dynamic-tool-discovery.md) |

更偏时序图（参与者竖线）的旧图仍在 [`diagrams/`](../diagrams/index.html)。
