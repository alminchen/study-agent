# 阶段 5 · 多 Agent 编排（Supervisor-Worker）— 学习计划

> 载体：`step1-chat`。目标：从单 Agent ReAct 进阶到多 Agent 协作，理解 Supervisor 分发、Worker 执行、结果汇总的编排模式。

## 为什么要学

- 单 Agent 面对复杂任务时容易"走偏"——一个模型又要规划又要执行，注意力被稀释
- 多 Agent 把"规划"和"执行"分离：Supervisor 负责拆任务和汇总，Worker 各自专注一个领域
- 这是从 demo 走向生产级 Agent 的关键分水岭（Cursor、Devin、AutoGPT 都是多 Agent）

## 核心概念

| 概念 | 说明 |
|------|------|
| Supervisor | 接收用户请求，决定分发给哪些 Worker，最后汇总结果回复用户 |
| Worker | 专注单一职能的子 Agent（如 WeatherWorker、KBWorker），各自有独立的工具集和 system prompt |
| 路由决策 | Supervisor 判断用户意图，选择调度哪些 Worker（可并行） |
| 结果汇总 | 各 Worker 返回结果后，Supervisor 整合成一段连贯回复 |
| 状态共享 | Worker 之间通过共享 state（LangGraph）或消息传递交换信息 |
| 终止条件 | Supervisor 判断信息已充分，不再分发，直接回复 |

## 与你现有代码的关系

你当前的架构：
```
用户 → runConversation(单 Agent) → askModel → applyToolCalls → reply
```

多 Agent 后变为：
```
用户 → Supervisor → 路由决策
                   ├── WeatherWorker（getWeather + getCurrentTime）
                   ├── KBWorker（searchDocs）
                   └── GeneralWorker（无工具，纯聊天）
       Supervisor ← 汇总 ← Worker 结果
```

## 学习路径

### 1. 概念理解（30 分钟）— 详见 `stage5-multi-agent-hands-on.md` 第 1 节

- 单 Agent 的三个瓶颈：注意力稀释、串行瓶颈、prompt 冲突
- Supervisor-Worker 模式：规划层 + 执行层 + 汇总层的三段式
- 单 Agent vs Supervisor-Worker 对比（并行能力、工具隔离、调试体验、延迟成本）
- 两种拓扑对比：Supervisor-Worker（中心化）vs Peer-to-Peer（去中心化）
- 何时该用多 Agent、何时不该（工具数量、子任务独立性、复杂度）
- LangGraph 多节点编排：每个 Worker 是图上的一个子图（subgraph）
- 类比现实：项目经理 = Supervisor，前端/后端开发 = Worker

### 2. 设计 Supervisor 路由（动手）

- Supervisor 用一次 LLM 调用判断意图，输出结构化路由决策
- 路由 schema 示例：`{ workers: ["weather", "kb"], query_per_worker: {...} }`
- 如果只需要一个 Worker → 单路由直达
- 如果需要多个 Worker → 并行调度

产出：`server/multi-agent/supervisor.ts`

### 3. 实现 Worker（动手）

每个 Worker 是独立的 mini ReAct 循环：
- **WeatherWorker**：只挂 `getWeather` + `getCurrentTime`，system prompt 专注天气/时间
- **KBWorker**：只挂 `searchDocs`，system prompt 专注知识库问答
- **GeneralWorker**：无工具，纯聊天

产出：`server/multi-agent/workers/`

### 4. 汇总节点（动手）

- Supervisor 拿到所有 Worker 的回复后，再调一次 LLM 整合成一段连贯回答
- 或者：单 Worker 场景直接透传，不浪费一次 LLM 调用

产出：`server/multi-agent/aggregate.ts`

### 5. LangGraph 多节点图（动手）

- 用 `StateGraph` 把 Supervisor → Workers → Aggregate 串起来
- 条件边：根据路由结果决定走哪些 Worker 节点
- 并行执行：LangGraph 支持同一层多个节点并行

产出：`server/multi-agent/graph.ts`

### 6. 接入现有 API（动手）

- 新增 `/api/chat/multi` 端点（保留原 `/api/chat` 不动）
- 前端加一个开关"多 Agent 模式"（类似知识库开关）
- SSE 流中增加 `worker_start` / `worker_done` trace event，过程面板可展示哪个 Worker 在干活

产出：修改 `server/index.ts`、前端开关

### 7. Evals 覆盖

- 新增多 Agent 专用测试用例：
  - 纯天气问题 → 只调度 WeatherWorker
  - 纯知识库问题 → 只调度 KBWorker
  - 混合问题（"查下天气顺便搜搜笔记里关于出行的建议"）→ 两个 Worker 并行
  - 闲聊 → GeneralWorker

## 难点

1. **路由准确性**：Supervisor 判断错了会把任务发给错的 Worker（如天气问题发给 KBWorker）
2. **延迟增加**：多一次 Supervisor 判断 + 汇总 = 至少多 2 次 LLM 调用
3. **状态一致性**：多 Worker 并行时的 state 管理
4. **何时不用多 Agent**：简单问题多 Agent 反而更慢更贵

## 验收标准

- [x] 能说清 Supervisor-Worker 和 Peer-to-Peer 的区别和适用场景
- [x] `supervisor.ts` 能根据用户输入输出路由决策
- [x] 至少实现 2 个 Worker（Weather + KB）
- [x] LangGraph 图能编排 Supervisor → Worker → Aggregate 完整流程
- [x] `/api/chat/multi` 端点可用，SSE 流包含 Worker trace event
- [x] 单 Worker 场景不做多余 LLM 调用（优化）
- [x] Evals 新增多 Agent 测试用例（`evals/dataset-multi.json` · `npm run eval:multi`）
- [x] `npx tsc --noEmit` 通过

> **本课已结（学习者确认了解完成；文档已同步）。**

## 参考

- [LangGraph Multi-Agent](https://langchain-ai.github.io/langgraphjs/tutorials/multi_agent/agent_supervisor/) — 官方 Supervisor 教程
- [CrewAI](https://github.com/joaomdmoura/crewAI) — 另一种多 Agent 框架（了解思路）
- 你的 `server/react/runConversation.ts` — 现有单 Agent LangGraph 图，新架构在此基础上扩展
