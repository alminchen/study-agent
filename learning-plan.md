# 前端 AI Agent 学习计划清单

> 基于 `frontend-ai-agent-learning-roadmap.merged.md`，每个阶段都有可验收的交付物。默认每天 2-3 小时。

## 当前进度

- 阶段 1：已完成
- 阶段 2：已完成
- 阶段 3：已完成
- 当前重点：阶段 4（ReAct / 多步 Agent）

## 下一步建议顺序

1. 先理解 RAG 的完整链路
2. 再做文档切分和 chunk 策略
3. 再做 Embedding 和相似检索
4. 再做上下文组织和裁剪
5. 再做 Reranker 和引用展示
6. 最后补前端可视化和空结果兜底

（以上 1～6 已在 `step1-chat` 跑通。）

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

## 阶段 4：真正的 Agent（第 2-3 个月）

- [ ] ReAct 模式：Reasoning → Acting → Observation
- [ ] LangGraph 状态机多步编排
- [ ] 多工具调用
- [ ] 失败重试
- [ ] 人工确认节点
- [ ] 执行轨迹可视化
- [ ] 交付：可完成多步任务的 Agent

## 阶段 5：工程化与差异化（第 3-6 个月）

- [ ] MCP：用 TypeScript 暴露业务工具给 LLM
- [ ] Tracing（LangSmith / Phoenix）
- [ ] Evals：测试数据集 + 自动评估
- [ ] Token 统计与成本控制
- [ ] 错误恢复和降级策略
- [ ] Prompt Injection 基础防护
- [ ] 多 Agent 编排（Supervisor-Worker）
- [ ] FastAPI + Docker 部署
- [ ] 交付：调试页、日志页、成本页 + eval 数据集

## 项目方向（作品集）

- [ ] 前端开发助手：需求转代码、组件生成、Bug 分析
