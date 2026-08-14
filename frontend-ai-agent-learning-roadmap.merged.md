# 前端开发者 AI Agent 学习路径（融合版）

> 融合自 `frontend-ai-agent-learning-roadmap.frontend.md` 与 `frontend-ai-agent-learning-roadmap.md`。
> 核心结论：前端转 AI Agent 不需要先学模型原理或转 Python，而是把已有能力迁移到 AI 应用层，补上 LLM API、Tool Calling、RAG、Agent 编排、Evals/MCP 这几块短板。

## 1. 核心思路

前端已有能力对应关系：

| 已会的能力 | Agent 中的对应 |
| --- | --- |
| Fetch / Axios | LLM API 调用（含流式 SSE） |
| async/await + 事件循环 | ReAct 推理-行动循环 |
| 状态管理 | Agent 短期/长期记忆、工作流状态 |
| TypeScript 类型 | Tool Schema / Function Calling |
| 流式渲染 / 生成式 UI | 实时输出、执行轨迹可视化 |
| 接口封装 | Tool Calling 和外部系统集成 |

先学：LLM API 和流式输出、Function/Tool Calling、RAG 基础、Agent 编排与状态流转、Evals/日志/可观测性、MCP。

暂缓：训练模型、深度学习细节、复杂算法推导、纯 Python 大规模数据管线。

## 2. 五个学习阶段

### 第 1 阶段：会说话的 UI（第 1 周）

目标：不依赖 Agent 框架，裸调通 LLM API，做通流式聊天。

要掌握：
- API Key 管理、Token 计费
- 流式输出（SSE / ReadableStream）
- 多轮对话的 `messages` 结构
- 中断、重试、清空会话、模型切换
- 历史记录持久化

交付物：一个可用的 Chat 页面（消息列表 + 输入框 + 流式回复 + 本地历史）。

提示：第一周务必裸写一次 `fetch + ReadableStream`，之后再上框架。

### 第 2 阶段：让模型会做事（第 2 周）

目标：加上 Function Calling，让模型真正调用工具。

要掌握：
- 定义工具 schema（TS 类型可直接当工具描述）
- 模型决定何时调用工具、传什么参数
- 工具结果回填对话
- 参数校验和错误提示

交付物：一个能查天气/日程/本地数据的聊天助手 + 展示工具调用过程的调试面板。

关键理解：Prompt 负责“怎么说”，Tool Calling 负责“怎么做”。

### 第 3 阶段：可解释的 RAG（第 3-4 周）

目标：完成“和你的 PDF/Markdown 聊天”的私有知识库问答。

要掌握：
- 文档切分（chunk size、overlap 对召回的影响）
- Embedding 入库
- 相似检索（向量库）
- Reranker 重排序
- 引用来源展示、空结果提示

推荐栈：LangChain.js + Chroma/Qdrant + BGE-M3（中文场景）。

交付物：上传文档后可问答，回答带引用来源，前端可视化 chunk 命中情况。

### 第 4 阶段：真正的 Agent（第 2-3 个月）

目标：完成能自主调用多个工具的 AI Agent。

要掌握：
- ReAct 模式：Reasoning → Acting → Observation → 循环
- Agent 状态机：用 LangGraph 做多步编排
- 失败重试、人工确认节点
- 执行轨迹可视化

交付物：一个调用天气 API、日历、数据库查询等多工具的 Agent，带完整执行链路可视化面板。

### 第 5 阶段：工程化与差异化（第 3-6 个月）

目标：把 Demo 变成生产级、可展示、可复用的项目。

要掌握：
- MCP：用 TypeScript 把现有业务能力暴露给任意 LLM（建议尽早学）
- Tracing：LangSmith 或 Phoenix
- Evals：构建测试数据集，自动评估输出，幻觉检测、Bad Case 分析
- Token 统计与成本控制
- 错误恢复和降级策略
- Prompt Injection 基础防护
- 多 Agent 编排（Supervisor-Worker）、FastAPI + Docker 部署

交付物：一个有调试页、日志页、成本页的 AI 应用 + 一套可复测的 eval 数据集。

## 3. 技术选型

| 场景 | 选谁 |
| --- | --- |
| 聊天界面 / Next.js 项目 | Vercel AI SDK（useChat 开箱即用） |
| 复杂 Agent / RAG / 多步编排 | LangChain.js + LangGraph |
| 只调一家、追求极简 | OpenAI SDK |
| 向量库 | Chroma（本地优先）或 Qdrant |
| Embedding | BGE-M3（中文） |
| 验证最小闭环 | 基础 fetch，先不引框架 |

推荐生产架构：

```
前端组件（useChat）
    ↓
API Route（/api/chat）
    ↓
LangChain.js 跑 RAG / Agent / 工具编排
    ↓
Vercel AI SDK 负责流式返回
    ↓
前端逐字渲染
```

误区：
- 别用 Vercel AI SDK 硬做复杂 Agent，它不适合多步有状态流程
- 别用 LangChain 管前端 UI，它没有流式 UI

## 4. 时间线

默认每天 2-3 小时。

| 时间 | 重点 | 验收 |
| --- | --- | --- |
| 第 1 周 | 裸调 API + 流式 Chat | 多轮、流式、模型切换、历史保存 |
| 第 2 周 | Function Calling + 调试面板 | 能调用一个真实工具并展示过程 |
| 第 3-4 周 | 最小 RAG | 上传文档问答 + 引用来源 |
| 第 2 个月 | LangGraph 多步 Agent | 多工具编排 + 轨迹可视化 |
| 第 3 个月 | MCP + Evals + 可观测性 | 调试页、日志页、成本页、eval 集 |
| 第 4-6 个月 | 垂直领域 + 工程化打磨 | 完整作品集项目，能讲清业务价值 |

30 天结束后应有一个可演示的 AI 产品原型，而不是零散笔记。

## 5. 最容易踩的坑

1. 只学 Prompt，不学 Function Calling → 高级聊天框
2. 一开始追最复杂框架 → 细节被隐藏，忽略问题本身
3. 只搭 Demo，不做日志和失败处理 → 面试官无话可聊
4. 纠结转 Python → 先把 JS/TS 路线做通
5. 只写功能，不做可视化 → 丢掉前端最大的差异化优势

## 6. 推荐项目方向

- 前端开发助手：需求转代码、组件生成、Bug 分析
- 企业内部操作助手：报表、工单、审批、查询
- AI Native 工作台：自然语言驱动后台操作
- 文档问答系统：引用来源和结果追踪

选一个垂直领域（金融、教育、法律、医疗、电商）深入，差异化竞争力在领域知识，不在技术本身。
