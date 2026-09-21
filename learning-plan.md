# 前端 AI Agent 学习计划清单

> 基于 `frontend-ai-agent-learning-roadmap.merged.md`，每个阶段都有可验收的交付物。默认每天 2-3 小时。  
> **项目对照拓扑（方法调用）：** [`step1-chat/docs/project-topology.html`](step1-chat/docs/project-topology.html)

## 协作红线（对 AI / 代写代码同样生效）

1. **不允许私自删除我的代码注释。**  
   改逻辑、接新功能时，必须保留原有教学/说明注释；只能在旁**增补**新注释。  
   禁止为了「整文件重写更干净」而把注释冲掉。若注释与代码冲突，先问我再改，不得擅自删。

## 当前进度

- 阶段 1：已完成
- 阶段 2：已完成
- 阶段 3：已完成
- **阶段 4：基本学习完毕**（ReAct、工具失败、过程面板、LangGraph、`searchDocs` + 输入框「搜索知识库」开关）
- **阶段 5 · MCP**：已完成（`stage5-mcp-learning-plan.md`、`stage5-mcp-hands-on.md`）
- **阶段 5 · Tracing**：已完成（`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`）
- **阶段 5 · Evals**：已完成（`stage5-evals-learning-plan.md`、`stage5-evals-hands-on.md`）
- **阶段 5 · 错误恢复与降级**：已完成（`stage5-resilience-learning-plan.md`、`docs/resilience-failure-map.md`）
- **阶段 5 · Prompt Injection 基础防护**：已完成（`stage5-prompt-injection-learning-plan.md`）
- **阶段 5 · 多 Agent 编排**：已完成（`stage5-multi-agent-learning-plan.md`、`evals/dataset-multi.json`、`npm run eval:multi`）
- **阶段 5 · Token 统计与成本控制**：已完成（`stage5-token-cost-learning-plan.md`、`stage5-token-cost-hands-on.md`）
- 当前重点：**阶段 5 · 交付页**（调试页、日志页、成本页 + eval 数据集）
- **FastAPI + Docker 部署**：暂不学习（后置/跳过，需要时再补）
- 人工确认（有后果的动作先问人再执行）：**阶段 A+B 已落地**（假工具 + ConfirmSession + `/api/chat` 对接 + 过程面板允许/拒绝）  
  - 说明：`stage4-human-confirm-overview.md`  
  - 计划：`stage4-human-confirm-learning-plan.md`  
  - 修改记录：`step1-chat/docs/human-confirm-changelog.md`（请按回归表手测勾选）
  - **多 Agent 接入确认**：已落地（方案 A `actionWorker`）；记录见 `step1-chat/docs/multi-agent-human-confirm-changelog.md`；清单 `stage5-multi-agent-human-confirm-learning-plan.md`
- **工程优化 / 逻辑清理**：全部学完后再做，见 `post-learning-optimization-plan.md`（现在不要做）
- 详细计划：`stage4-react-learning-plan.md`、`stage4-tool-failure-learning-plan.md`、`stage4-react-process-learning-plan.md`（图 + 过程面板，原 trace-ui / langgraph 已合并）、`stage4-kb-search-tool-learning-plan.md`（均已结）、`stage4-human-confirm-learning-plan.md` + `stage4-human-confirm-overview.md`（单 Agent 已结）、`stage5-multi-agent-human-confirm-learning-plan.md`（multi 确认，排队）

## 下一步建议顺序

### 阶段 4（已结）

1. [x] ReAct：有 `tool_calls` 就执行再问，没有才把文字交给页面
2. [x] 工具失败回填（参数错 / 未知工具 / 业务失败 / 连续失败上限）
3. [x] ReAct 过程：LangGraph 图 + 页面按次展示工具（`stage4-react-process-learning-plan.md`；`runConversation.forLoop.ts` 保留备份）
4. [x] 知识库检索工具 `searchDocs`（执行侧复用 `retrieveForAnswer`；勾选「搜索知识库」才挂给模型；勾选后服务端先强制检索，再进 ReAct；不勾选不检索）
5. （全部主线之后）有后果的动作先问人再执行

### 阶段 5（下一课）

1. [x] MCP：用 TypeScript 暴露业务工具给 LLM（`stage5-mcp-learning-plan.md`、`stage5-mcp-hands-on.md`）
2. [x] Tracing（LangSmith / Phoenix）（`stage5-tracing-learning-plan.md`、`stage5-tracing-hands-on.md`）
3. [x] Evals：测试数据集 + 自动评估（`stage5-evals-learning-plan.md`、`stage5-evals-hands-on.md`）
4. [x] 错误恢复和降级策略（`stage5-resilience-learning-plan.md`）
5. [x] Prompt Injection 基础防护（`stage5-prompt-injection-learning-plan.md`）
6. [x] 多 Agent 编排（Supervisor-Worker）
7. ~~FastAPI + Docker 部署~~（暂不学习，后置）
8. [x] Token 统计与成本控制
9. [ ] 交付：调试页、日志页、成本页 + eval 数据集 ← **当前**
10. [x] 多 Agent 接入人工确认（`stage5-multi-agent-human-confirm-learning-plan.md` / `multi-agent-human-confirm-changelog.md`）

（阶段 3 的 RAG 1～6 已在 `step1-chat` 跑通；上传/分类见 `dynamic-kb-learning-plan.md`，后移。）

## 阶段 1：会说话的 UI（第 1 周）

- [x] 项目搭建：Vue 3 + Vite + TypeScript + Express 骨架
- [x] 裸写 `fetch + ReadableStream`，不依赖 Agent 框架
- [x] 调通一个 LLM API（DeepSeek / 通义千问 / OpenAI 兼容接口）
- [x] 流式输出（SSE）
- [x] 多轮对话（`messages` 结构）
- [x] 模型切换
- [x] 中断、重试、清空会话
- [x] 历史记录持久化（localStorage）
- [x] 无 API Key 时可 Mock 演示

## 阶段 2：让模型会做事（第 2 周）

- [x] 定义工具 schema（TS 类型）
- [x] Function Calling：模型决定何时调用工具
- [x] 工具结果回填对话
- [x] 参数校验和错误提示
- [x] 工具调用过程调试面板
- [x] 交付：能查天气/日程/本地数据的聊天助手

## 阶段 3：可解释的 RAG（第 3-4 周）

载体：`step1-chat`。学习闭环已完成；上传文档 UI、Chroma 服务、PDF 明确后置。

- [x] 文档切分（chunk size / overlap）
- [x] Embedding 入库（学习用 `bge-large-zh-v1.5` + 本地 JSON 库；总计划里的 BGE-M3 / Chroma 后置）
- [x] 相似检索
- [x] 上下文组织：只保留最近几轮 + 固定 `system` prompt
- [x] Reranker 重排序（向量召回 Top20 → `bge-reranker-base` 取 Top5）
- [x] 引用来源展示（`[n]` 只认注入列表，可点到真实 chunk）
- [x] 空结果提示（分数门槛 + 标题点名例外）
- [x] 前端可视化 chunk 命中
- [ ] 交付：上传文档后问答的完整应用（后置：现在是 `rag:ingest` + 页面「资料问答」）

### 阶段 3 学习顺序

1. [x] 先弄懂什么是 RAG，为什么要先检索再回答
2. [x] 再理解文档切分，知道 chunk size 和 overlap 怎么影响结果
3. [x] 再学习 Embedding 与向量检索
4. [x] 再做上下文裁剪，只保留最近几轮并固定 `system` prompt
5. [x] 再学 Reranker，理解为什么要重新排序
6. [x] 再把引用来源、命中结果和空状态展示出来
7. [ ] 最后补成一个完整的上传文档问答流程（后置）

## 阶段 4：真正的 Agent（第 2-3 个月）— 基本学习完毕

分段学，不要一次混完。载体：`step1-chat` 的 `/api/chat`。

- [x] ReAct：`runConversation` 循环；天气/时间多步；`MAX_MODEL_TURNS` 上限
- [x] 工具失败回填（详见 `stage4-tool-failure-learning-plan.md`）
- [x] 执行过程在页面上按次可见 + LangGraph / 状态图对照（详见 `stage4-react-process-learning-plan.md`；现网走图）
- [x] 知识库检索工具 `searchDocs`（详见 `stage4-kb-search-tool-learning-plan.md`；勾选才挂给模型；勾选后 `prefetchSearchDocs` 先强制检索再进 ReAct；`/api/rag/chat` 仍是另一条路）
- [x] 交付：多步任务、失败可见、过程可讲清；聊天可按需检索笔记（与「资料问答」两条路并存）
- [ ] 人工确认（有后果的动作）：**全部计划最后再学**  
  - 说明：`stage4-human-confirm-overview.md`  
  - 计划：`stage4-human-confirm-learning-plan.md`

## 阶段 5：工程化与差异化（第 3-6 个月）

- [x] MCP：用 TypeScript 暴露业务工具给 LLM
- [x] Tracing（LangSmith / Phoenix）（概念：`stage5-tracing-learning-plan.md`；动手：`stage5-tracing-hands-on.md`）
- [x] Evals：测试数据集 + 自动评估（概念：`stage5-evals-learning-plan.md`；动手：`stage5-evals-hands-on.md`）
- [x] 错误恢复和降级策略（`stage5-resilience-learning-plan.md`、`docs/resilience-failure-map.md`）
- [x] Prompt Injection 基础防护（`stage5-prompt-injection-learning-plan.md`）
- [x] 多 Agent 编排（Supervisor-Worker）
- ~~FastAPI + Docker 部署~~（暂不学习，后置）
- [x] Token 统计与成本控制（`stage5-token-cost-learning-plan.md`）
- [ ] 交付：调试页、日志页、成本页 + eval 数据集（**当前**）
- [x] 多 Agent 接入人工确认（`stage5-multi-agent-human-confirm-learning-plan.md`，changelog 见 step1-chat/docs）

### 阶段 5 顺序说明

建议收尾顺序（已跳过部署）：`交付页` → `人工确认` → `post-learning-optimization-plan.md` 工程优化。（`FastAPI + Docker` 需要时再补）

## 项目方向（作品集）

- [ ] **当前主推：Bug 分析（做进 step1-chat，薄改动）**  
  - 文档：`frontend-bug-analysis-implementation.md`（精简版：复用 `/api/chat`，不新开项目）  
  - MVP：报错输入模板 + bug system；勾选 KB 时无命中仍继续 LLM  
- [ ] 后置：需求转代码 → `frontend-dev-assistant-implementation.md`

## 全部学完之后（现在不要做）

- [ ] 性能与逻辑清理：工具轮 thinking、知识库双路径、观测对齐等，见 `post-learning-optimization-plan.md`
