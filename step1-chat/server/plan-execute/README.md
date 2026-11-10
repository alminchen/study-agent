# server/plan-execute/ — Plan-and-Execute（计划 → 顺序执行 → 受控 Re-plan）

> 所属学习阶段：**进阶学习第 2 项 · Plan-and-Execute（步骤 0–12 已完成）**
> 实施计划：`tasks/plan-and-execute-plan.md` · 架构说明：`docs/plan-and-execute.md`
> 流程图：`docs/plan-and-execute-flow.svg` · 拓扑：`docs/project-topology.html` §6d

## 模块职责

把多步任务拆成**可校验的计划**，让 Executor 每次只执行一个步骤、只拿当前步骤
需要的上下文和工具；步骤失败时最多做一次受控 Re-plan，最后由独立节点组织终答。

简单任务不进 Planner，继续走单 Agent ReAct。整条链路是一条主链 + 一个回退分支，
所以刻意不引入 LangGraph —— 顺序事件数组让「事件顺序可预测」「状态转换可断言」
变得直接（见 `graph.ts` 头注释）。

## 文件说明

| 文件 | 职责 |
|------|------|
| `types.ts` | 共享协议：Plan/PlanStep（模型产物，生成后不可变）、PlanRun/PlanStepResult（服务端运行时状态）、错误码、SSE 事件契约 |
| `classify.ts` | 规则分类器（纯函数，不调模型）：判断走 ReAct 还是 Plan-and-Execute |
| `prompts.ts` | 三套提示词 + `emit_plan` 工具 schema：只输出计划、不回答用户；有长期记忆时追加「## 用户长期记忆」小节（无记忆时逐字不变） |
| `schema.ts` | Zod 计划契约与长度上限，`validatePlan` 归一化并报错码 |
| `planner.ts` | Planner 契约 + 真实实现：让模型用 `emit_plan` 吐出可校验 JSON |
| `executor.ts` | Executor 契约 + 真实实现：执行单个步骤，返回**不可信**的 `PlanStepResult` |
| `replan.ts` | 受控 Re-plan：门槛判定、候选计划校验、真实 Replanner |
| `finalReply.ts` | 终答节点：把已完成步骤组织成给用户的一段答复 |
| `graph.ts` | 主图（纯函数状态机 + 显式事件序列）：classify → plan → execute → finalReply |
| `observe.ts` | 观测收集器：把图里发生的事压成 13 个字段，供日志行与 LangSmith span 共用 |
| `mock.ts` | Mock Planner / Mock StepExecutor / Mock ConfirmSession：无 API Key 跑通整张图 |
| `*.test.ts` | 各层单测（分类 / schema / 提示词 / Executor / Re-plan / 主图） |

入口路由：[`server/routes/chatPlan.ts`](../routes/chatPlan.ts)。

## 三段独立上下文（关键设计）

计划模式**不把长 chat 历史整段塞给模型**，三段调用各自只拿需要的东西：

| 段 | 上下文 | 工具 |
|----|--------|------|
| 规划 | `[system(计划提示词), user(问句)]` | `emit_plan`（只产出计划） |
| 单步 | `[system(单步提示词), user(目标 + 当前步 + 已完成摘要)]` | 本步白名单（≤3 个） |
| 终答 | `[system(终答提示词), user(已完成步骤摘要)]` | 无 |

长期记忆（可选）：路由层 `routes/chatPlan.ts` 检索**一次**，
经 `graph.ts` 下发给 planner / 每一步 / 终答 / re-plan，
在各自 system 提示词**末尾**追加「## 用户长期记忆」小节（无记忆时提示词逐字不变）。
ReAct 回退路径走 `chat.ts`，记忆以独立 system 消息注入。

## 关键常量

| 常量 | 值 | 含义 |
|------|----|------|
| `MAX_MODEL_CALLS` | 15 | 整任务模型调用上限（含 Planner / Executor / 终答，Re-plan 也从这里扣） |
| `MAX_PLAN_STEPS` | 6 | 计划最多 6 步 |
| `MAX_STEP_TOOLS` | 3 | 单步最多挂 3 个工具 |
| `MAX_STEP_MODEL_TURNS` | 2 | 单步最多 2 次模型调用（第二轮还要工具 → `step_turn_limit`） |
| `MAX_REPLAN` | 1 | Re-plan 次数上限 |
| `MAX_PLAN_JSON_CHARS` | 4000 | 计划 JSON 长度上限 |

## SSE 事件契约

事件类型定义在 `types.ts`，前端 `src/types.ts` 存一份同名字段，两边靠契约对齐。

| 事件 | 时机 |
|------|------|
| `plan_route` | 分类完成，告知最终走 react 还是 plan |
| `plan_created` | 计划已生成并通过校验 |
| `plan_step_started` | 某一步开始执行 |
| `plan_step_done` | 某一步成功结束 |
| `plan_step_failed` | 某一步失败（带 `code` / `retryable`） |
| `plan_replanned` | 受控 Re-plan 产生新 revision |
| `plan_finished` | 终态：completed / failed / aborted |
| `plan_fallback` | 计划不可用，已回退 ReAct（**只退一次**） |

正常顺序：`plan_route → plan_created → plan_step_started → plan_step_done →（可选
plan_replanned）→ plan_finished`。工具过程事件（`tool_call` / `tool_result` /
`pending_confirm` / `confirm_resolved`）走独立出口 `onTrace`，与计划事件**不混流**。

## 错误码

| 错误码 | 含义 |
|--------|------|
| `classify_failed` | 分类阶段异常 |
| `planner_failed` | 模型没返回可用的结构化计划 |
| `invalid_plan` | 计划不满足契约（含长度/步数/白名单/知识库约束） |
| `plan_empty` | 计划没有步骤 |
| `plan_too_long` | 计划超出长度上限 |
| `step_turn_limit` | 单步模型轮次超限 |
| `step_tool_limit` | 单步工具数超限 |
| `tool_not_allowed` | 步骤要用的工具不在本步白名单 |
| `tool_failed` | 工具执行失败 |
| `confirm_denied` | 人工确认被拒（**原样透传，不被吞掉**） |
| `replan_limit` | Re-plan 次数用尽 |
| `model_budget_exhausted` | 整任务模型预算耗尽 |
| `aborted` | 用户中止 |
| `final_reply_failed` | 终答生成失败 |

## 分类 reasonCode

`classifyTask` 返回 `mode`（`react` / `plan`）+ `reasonCode` + `signals`：

`explicit_react` · `explicit_plan` · `single_step` · `multi_capability` ·
`sequential_keywords` · `research_then_produce` · `artifact_request` ·
`too_ambiguous`

分类只读**最后一条用户消息** + 显式 mode + searchDocs 开关，不读完整历史。

## 观测（13 字段）

`observe.ts` 输出的 `PlanObservation`：

`requestId` · `planId` · `revision` · `mode` · `reasonCode` · `stepId` ·
`modelCalls` · `toolCalls` · `replanCount` · `plannerLatencyMs` ·
`totalLatencyMs` · `abortReason` · `errorCode`

刻意**不记录**：完整 prompt、工具结果原文、用户消息全文。用户消息只保留短预览
（`USER_PREVIEW_LIMIT = 120`，与 chat-request 的 `user_preview` 对齐）。

## 数据流

```
POST /api/chat/plan
  → classifyTask（规则）→ react? ──是──→ ReAct 兜底（一次）
  → Planner（emit_plan）→ validatePlan → plan_created
  → 逐步执行：Executor 只带本步白名单工具 → plan_step_done / plan_step_failed
      └─ 可恢复失败 → decideReplan → Re-planner（≤1 次）→ plan_replanned
  → finalReply → plan_finished
```

## API 端点

`POST /api/chat/plan`（`server/routes/chatPlan.ts`）

请求体：`{ messages, model, mode?: "auto" | "react" | "plan", searchDocs?: boolean }`

前端开关：`planEnabled`（localStorage，默认关）+ `planMode`。`auto` 由规则分类决定
走哪条链路。

## 边界与已知约束

- **计划状态只在内存 `planState`**：`ChatMessage` 没有 plan 字段，刷新页面不会把
  计划写进历史。
- **知识库开启时计划必须含检索步骤**，否则 `invalid_plan`（未拍板的硬约束）。
- `searchDocs` 未开启时不在可用工具里，模型拿不到、也不会排进步骤。
- 计划非法只回退 ReAct **一次**，不重试第二次 Planner。
- 确认拒绝、中止、安全拦截一律**不触发** Re-plan。

## 测试

```bash
cd server && node --import tsx --test plan-execute/*.test.ts routes/chatPlan.test.ts
```

离线评测（不需要 API Key）：`npm run eval:plan`。
