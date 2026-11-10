# 流程 SVG 索引

与 `human-confirm-flow.svg` 同风格的泳道流程图（含方法名与调用链）。

**浏览器一页浏览全部图：** [flows-index.html](./flows-index.html)

**学习计划 ↔ 项目方法级拓扑：** [project-topology.html](./project-topology.html)

| 图 | 说明 | 对应文档 |
|----|------|----------|
| [crosscutting-token-guard-trace-flow.svg](./crosscutting-token-guard-trace-flow.svg) | **横切流程图**：插入点 → Token 流 → Guard 三道门 → Trace 双通道 → 三端点对照 | usage/ · guard/ · tracing/ |
| [structured-output-flow.svg](./structured-output-flow.svg) | **Streaming 结构化输出**：请求 → provider 流 → partial parser → 稳定 snapshot → 最终 Zod → Vue 终态 | [structured-output.md](./structured-output.md) · 拓扑 [§6c](./project-topology.html#structured) |
| [plan-and-execute-flow.svg](./plan-and-execute-flow.svg) | **Plan-and-Execute**：规则路由 → Planner 产计划 → 顺序 Executor → 受控 Re-plan → 最终回答 + 观测 | [plan-and-execute.md](./plan-and-execute.md) · 拓扑 [§6d](./project-topology.html#plan) |
| [long-context-flow.svg](./long-context-flow.svg) | **长上下文管理**：预算窗口 + 结构化摘要 → buildContext 分层 → 摘要降级 → context_compacted | [long-context.md](./long-context.md) · 拓扑 [§6e](./project-topology.html#long-context) |
| [human-confirm-flow.svg](./human-confirm-flow.svg) | 单 Agent 人工确认完整泳道（wait/resolve/dispose）+ §6 横切归属 | [human-confirm-changelog.md](./human-confirm-changelog.md) |
| [multi-agent-human-confirm-flow.svg](./multi-agent-human-confirm-flow.svg) | **多 Agent 人工确认**：chatMulti → graph → actionWorker → runToolSafely → 共用 confirm API | [multi-agent-human-confirm-changelog.md](./multi-agent-human-confirm-changelog.md) |
| [chat-react-flow.svg](./chat-react-flow.svg) | 单 Agent ReAct + Accumulator / Guard / Trace | [project-messages-flow.md](./project-messages-flow.md) §三 |
| [chat-multi-flow.svg](./chat-multi-flow.svg) | 多 Agent + source 分桶计费 / Guard | [project-messages-flow.md](./project-messages-flow.md) §四 |
| [rag-chat-flow.svg](./rag-chat-flow.svg) | 召回→判空→重排→注入 + Token + **三道 Guard** + **SSE Trace** + **LangSmith** | [rag-input-output-guard-changelog.md](./rag-input-output-guard-changelog.md) · [project-messages-flow.md](./project-messages-flow.md) §五 |
| [rag-query-enhance-flow.svg](./rag-query-enhance-flow.svg) | **检索前问句增强**：意图/扩写/路由/Multi-Query/HyDE + env 开关 + meta 面板 | [rag-query-enhance-notes.md](./rag-query-enhance-notes.md) · [计划](../../rag-query-intent-rewrite-learning-plan.md) · 拓扑 [§6b](./project-topology.html#rag-enhance) |
| [llm-judge-flow.svg](./llm-judge-flow.svg) | **LLM-as-Judge 语义判定（阶段 6）**：三个判定面（input/retrieval/output）→ 正则与 Judge 双层防线 → off/shadow/enforce 三档决策 → judge_shadow / judge_enforced trace → 70 条离线评测与七条 enforce 准入阈值 | [llm-judge.md](./llm-judge.md) · [llm-judge-changelog.md](./llm-judge-changelog.md) · 拓扑 [§6f](./project-topology.html#judge) |
| [reflection-flow.svg](./reflection-flow.svg) | **Reflection 自我评估与重写（阶段 7）**：独立端点与三档模式 → Critic 四维评分与失败分支 → 阈值裁决 → 重写与事实守卫 → 重评回退与 trace 事件 → 与 Judge 的分层 → 离线评测准入 | [reflection.md](./reflection.md) · [reflection-changelog.md](./reflection-changelog.md) · 拓扑 [§6g](./project-topology.html#reflection) |
| [memory-flow.svg](./memory-flow.svg) | **跨会话记忆 Memory（阶段 8）**：开关与匿名 userId → 检索阈值 0.45 / Top-5 → 注入渲染与预算裁剪 → 旁路抽取与敏感信息两道闸 → 去重合并与原子落盘 → 记忆管理接口与面板 → trace 事件 → 四链路接入现状 | [memory.md](./memory.md) · [memory-changelog.md](./memory-changelog.md) · 拓扑 [§6h](./project-topology.html#memory) |
| [messages-assembly-flow.svg](./messages-assembly-flow.svg) | messages 三层 × 三条链路总览 | [project-messages-flow.md](./project-messages-flow.md) |
| [resilience-failure-flow.svg](./resilience-failure-flow.svg) | 失败地图与恢复策略 | [resilience-failure-map.md](./resilience-failure-map.md) |
| [dynamic-tool-discovery-flow.svg](./dynamic-tool-discovery-flow.svg) | **工具动态发现（阶段 5 已落地）**：启动扫描 modules/* → discoverTools() 校验 → createRegistry() 派生唯一清单 → Guard / MCP / Chat / Worker 四路消费 | [dynamic-tool-discovery.md](./dynamic-tool-discovery.md) · 拓扑 [§7b](./project-topology.html#tools) |

Markdown 索引与浏览器版 [flows-index.html](./flows-index.html) 一一对应，所有流程图资产均位于当前 `docs` 目录。

## 配套文档（无流程图）

| 文档 | 说明 |
|------|------|
| [mcp-usage.md](./mcp-usage.md) | **MCP 对外接入**：外部客户端配置写法（`command`/`args`/`cwd` 三件套）· 各客户端配置位置 · 暴露哪些工具 · 验证步骤 · 五个坑 |
| [llm-judge.md](./llm-judge.md) | **LLM-as-Judge 语义判定（阶段 6）**：概念、分工、Schema、三档模式、接入点、评测与故障排查 |
| [llm-judge-changelog.md](./llm-judge-changelog.md) | **阶段 6 变更记录**：新增 12 文件 / 修改 15 文件清单、判定结果结构、评测结果与七条阈值对照 |
| [reflection.md](./reflection.md) · [reflection-changelog.md](./reflection-changelog.md) | **阶段 7 Reflection**：自我评估偏差、与 Judge 分层、默认不启用条件；变更记录 |
| [memory.md](./memory.md) · [memory-changelog.md](./memory-changelog.md) | **阶段 8 Memory**：跨会话记忆数据模型、事实 vs 语义选型对比、实测数据、隐私设计；变更记录 |
