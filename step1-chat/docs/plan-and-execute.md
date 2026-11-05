# Plan-and-Execute 架构说明

对应实施计划：`tasks/plan-and-execute-plan.md`（步骤 0–12 已全部完成）。

> 泳道流程图：[plan-and-execute-flow.svg](./plan-and-execute-flow.svg)
> 交互/messages 视角：[project-messages-flow.md](./project-messages-flow.md) · 拓扑：[§6d](./project-topology.html#plan)

## 1. 它解决什么问题

单 Agent 的 ReAct 链路里，模型一边想一边做：调哪个工具、下一步做什么，全在模型的
隐式推理里。用户看到的是「一段文字 + 几个工具调用」，看不到「准备做什么、做到哪、
为什么改主意」。任务一多（查资料 → 起草 → 发送），这种模式有三个硬伤：

| 痛点 | ReAct 的表现 | Plan-and-Execute 的做法 |
| --- | --- | --- |
| 过程不可见 | 计划只存在于模型脑子里 | 先出计划，前端按步骤渲染时间线 |
| 顺序不受控 | 「先查天气再查时间」也可能反着来 | 计划里的步骤顺序就是执行顺序 |
| 失败难定位 | 只知道「模型没答上来」 | 每一步有自己的状态与错误码 |

代价是：多一次规划调用、最终回答要等所有步骤跑完才出。**这是结构性的取舍，不是 bug。**

## 2. 整体链路

```
POST /api/chat/plan
        │
        ▼
   classify（纯规则，不调模型）
        │
        ├── mode = react ──────────────────► ReAct 兜底链路（一次跑完）
        │
        └── mode = plan
                │
                ▼
           Planner ──► validatePlan ──► 逐步执行 ──►（受控 Re-plan）──► 最终回答
                │            │              │                          │
                │            └─ 不合法 ─────┴─► 回退 ReAct 一次        │
                └─ planner_failed ─────────────────────────────────────► ┘
```

| 职责 | 文件 |
| --- | --- |
| 路由（ReAct / Plan 判定） | `server/plan-execute/classify.ts` |
| 计划提示词 | `server/plan-execute/prompts.ts` |
| 计划结构校验 | `server/plan-execute/schema.ts` |
| Planner（模型产出计划） | `server/plan-execute/planner.ts` |
| 单步 Executor | `server/plan-execute/executor.ts` |
| 受控 Re-plan | `server/plan-execute/replan.ts` |
| 最终回答 | `server/plan-execute/finalReply.ts` |
| 主图（状态机 + 事件序列） | `server/plan-execute/graph.ts` |
| 观测收集 | `server/plan-execute/observe.ts` |
| Tracing 适配 | `server/tracing/langsmith.ts` |
| HTTP / SSE 入口 | `server/routes/chatPlan.ts` |
| 前端计划时间线 | `src/components/PlanTimeline.vue` |

主图刻意没引入 LangGraph：整条链只有一条主链加一个回退分支，
「事件顺序可预测、状态转换可断言」用普通函数 + 事件数组更直接。

## 3. 路由规则

分类器是**纯规则函数**，输入只有「最后一条用户消息 + mode + 知识库开关」，
不调模型，因此 12 条样本可以离线断言。

| reasonCode | 判定 | 走向 |
| --- | --- | --- |
| `explicit_react` / `explicit_plan` | 请求里显式指定 mode | 按指定 |
| `research_then_produce` | 同时出现「查资料」和「写/起草/给建议」 | Plan |
| `sequential_keywords` | 「先……再……」且没有产出物 | Plan |
| `artifact_request` | 有产出物（对比/方案/计划/通知…） | Plan |
| `multi_capability` | 顺序词 + 多能力域 | Plan |
| `single_step` | 单步或说不清 | ReAct |
| `too_ambiguous` | 空消息 | ReAct |

天气、时间这类「单步只读工具」任务即使带顺序词也走 ReAct：
为一句「查天气」建计划不值得。

## 4. 计划契约

Planner 只允许模型调一个工具 `emit_plan`，参数就是整份计划：

```json
{
  "goal": "汇总广州天气与当前时间",
  "steps": [
    {
      "id": "step_1",
      "title": "查询广州天气",
      "action": "调用 getWeather 获取广州天气",
      "doneWhen": "拿到广州天气结果",
      "tools": ["getWeather"]
    }
  ]
}
```

硬约束（`schema.ts` 统一校验，越界一律回退 ReAct）：

| 约束 | 规则 | 违反时的错误码 |
| --- | --- | --- |
| 步数 | 1 ~ 6 步 | `plan_too_long` / `plan_empty` |
| 步骤 id | 必须从 `step_1` 连续到 `step_N` | `invalid_plan` |
| 每步工具数 | ≤ 3 | `invalid_plan` |
| 工具白名单 | 只能用本次可用的工具 | `invalid_plan` |
| 同一工具重复 | `tools` 是**白名单**语义，自动去重 | — |
| 知识库开启 | 计划里必须至少有一个 `searchDocs` 步骤 | `invalid_plan` |

`tools` 是白名单而不是「调用清单」：同一工具要调多次，把说明写进 `action`。
曾经把它当成调用清单，模型看到两个同名 `getWeather` 就真调了两次，
白白吃掉单步的 2 次模型调用预算 —— 所以校验时统一去重，提示词里也写死了这条。

## 5. SSE 协议

`POST /api/chat/plan` 是 SSE 流，事件顺序固定：

```
plan_route → plan_created → plan_step_started → plan_step_done
           →（可选 plan_replanned）→ plan_step_failed → plan_finished
```

| 事件 | 关键字段 | 前端用途 |
| --- | --- | --- |
| `plan_route` | `mode` `reasonCode` `signals` | 顶部显示「走了哪条链路、为什么」 |
| `plan_created` | `planId` `revision` `plan` | 渲染计划时间线（第一步执行前可见） |
| `plan_step_started` | `stepId` `index` `total` | 高亮当前步骤 |
| `plan_step_done` | `stepId` `summary` `toolsCalled` | 步骤打勾 + 摘要 |
| `plan_step_failed` | `stepId` `code` `message` `retryable` | 失败原因；`stepId` 为空表示计划级失败 |
| `plan_replanned` | `previousRevision` `revision` `plan` `reason` | 保留旧计划并展示新版本 |
| `plan_fallback` | `reasonCode` `message` | 说明为什么退回 ReAct |
| `plan_finished` | `status` `completedSteps` `totalSteps` | 终态 |

工具过程事件（`tool_call` / `tool_result` / `pending_confirm` / `confirm_resolved`）
与计划事件共用一个出口，但前端分开渲染：工具进工具面板，计划进时间线面板。

## 6. 状态机与终止条件

终态只有三种：`completed` / `failed` / `aborted`。

* 每一步都以 `done` / `failed` / `aborted` 收尾，不会「悬着」。
* 计划非法时**只回退一次** ReAct，不重试第二次 Planner。
* 模型调用预算是整任务共享的（默认 15 次）：规划 1 次、每步最多 2 次、
  Re-plan 1 次、最终回答 1 次。预算不足就停下，不再发模型请求。
* 用户点停止 → 立即中止，后续步骤不再开始。

### Re-plan 的边界

只有「这次失败换个做法可能成功」的失败才允许重规划：

| 错误码 | 可否 Re-plan |
| --- | --- |
| `tool_failed` / `step_tool_limit` / `step_turn_limit` / `tool_not_allowed` | 可 |
| `confirm_denied`（用户拒绝） | **不可**：不允许换一种方式绕过用户 |
| `aborted` | 不可 |
| `invalid_plan` / `plan_empty` / `plan_too_long` | 不可：计划本身错了，重规划也救不了 |

且**最多一次**。新计划必须满足：

1. 总目标不变；
2. 前 N 个已完成步骤**逐字段照抄**（id / 标题 / 动作 / 完成条件 / 工具）；
3. 步数 ≤ min(剩余预算能支撑的步数, 6)，且必须比已完成步数多（还得有活可干）。

## 7. 错误码

| 错误码 | 含义 | 层级 |
| --- | --- | --- |
| `classify_failed` | 分类失败 | 计划级 |
| `planner_failed` | 规划模型没调 `emit_plan` 或调用失败 | 计划级（回退 ReAct） |
| `invalid_plan` | 计划形状/工具/检索步骤不合法 | 计划级（回退 ReAct） |
| `plan_empty` | 空计划 | 计划级（回退 ReAct） |
| `plan_too_long` | 超过 6 步或 JSON 超长 | 计划级（回退 ReAct） |
| `step_turn_limit` | 单步模型调用超过 2 轮 | 步骤级 |
| `step_tool_limit` | 单步工具调用超过 3 次 | 步骤级 |
| `tool_not_allowed` | 模型调了本步骤白名单外的工具 | 步骤级 |
| `tool_failed` | 工具自身失败 | 步骤级 |
| `confirm_denied` | 用户拒绝了需要确认的动作 | 步骤级 |
| `replan_limit` | 已达一次重规划上限 | 步骤级 |
| `model_budget_exhausted` | 模型调用预算耗尽 | 计划级 / 步骤级 |
| `aborted` | 用户中止 | 步骤级 |
| `final_reply_failed` | 最终回答失败或为空 | 计划级 |

**层级很重要**：步骤级失败挂在具体 `stepId` 上，计划级失败 `stepId` 为空。
如果两者混在一起，用户会只看到「Re-plan 被拒」，看不到最初为什么失败 ——
所以计划级失败不允许覆盖步骤上已经写好的根因。

## 8. 观测

每次 `/api/chat/plan` 落一条日志，字段就是步骤 11 约定的 13 个：

| 字段 | 含义 |
| --- | --- |
| `requestId` | 一次前端请求的 id（串起日志与前端） |
| `planId` | 计划 id |
| `revision` | 计划版本（Re-plan 后 +1） |
| `mode` | 实际走的链路：`react` / `plan` |
| `reasonCode` | 路由原因 |
| `stepId` | 最后涉及的步骤 |
| `modelCalls` | 模型调用次数 |
| `toolCalls` | 工具调用次数 |
| `replanCount` | 重规划次数 |
| `plannerLatencyMs` | 计划成形耗时（规划慢是最常见的体感问题） |
| `totalLatencyMs` | 整段请求耗时 |
| `abortReason` | 中止原因 |
| `errorCode` | 结束时的错误码 |

日志形态（只记观测字段 + 用户消息短预览，**不记完整 prompt、不记工具结果原文**）：

```text
[plan] {"requestId":"req_m1x2ab_9f3c1d","planId":"plan_m1x2ab","revision":0,
 "mode":"plan","reasonCode":"sequential_keywords","stepId":"step_2",
 "modelCalls":7,"toolCalls":2,"replanCount":0,"plannerLatencyMs":812,
 "totalLatencyMs":4310,"abortReason":null,"errorCode":null,
 "user_preview":"先查广州天气，再查现在几点，最后总结"}
```

LangSmith 侧对应 `plan-request`（chain）与 `plan-planner`（llm）两个 span，
开关是 `LANGCHAIN_TRACING_V2=true`；关掉时这层完全不打网络请求。

## 9. Evals

数据集：`evals/dataset-plan.json`（22 条 = 12 条路由样本 + 10 条场景剧本）。
脚本：`scripts/run-plan-evals.ts`。

```bash
npm run eval:plan                    # 全部
npm run eval:plan -- --id plan-order-steps
npm run eval:plan -- --verbose       # 附带观测值
npm run eval:plan -- --compare       # 真实模型对比（需 LLM_API_KEY，且 MOCK_MODE != 1）
```

> 受限环境（不允许 tsx 建 IPC socket）里改用 `node --import tsx scripts/run-plan-evals.ts`，
> 参数完全一样。

默认是**离线 Mock**：不打模型、不调真实工具，用预置剧本跑完整张图再规则判分，
所以能进 CI。跑的是图与状态机，不是模型质量。

任务文档要求的 10 条覆盖关系：

| 要求 | 用例 |
| --- | --- |
| 1. 简单问题不调用 Planner | `simple-greeting`（另 5 条同类） |
| 2. 复杂问题计划步骤有序 | `plan-order-steps` |
| 3. 计划步骤数不超过 6 | `plan-too-many-steps`（7 步被拒）、`plan-order-steps` |
| 4. 非法计划回退 ReAct | `plan-invalid-tool` |
| 5. 空计划回退 ReAct | `plan-empty` |
| 6. 第二步工具失败后最多 Re-plan 一次 | `plan-replan-once`、`plan-replan-limit` |
| 7. 用户拒绝确认后不 Re-plan | `plan-confirm-denied` |
| 8. 中止后不执行下一步 | `plan-abort-after-first-step` |
| 9. 模型调用预算耗尽后停止 | `plan-model-budget-exhausted` |
| 10. 最终回答只引用已执行步骤 | `plan-final-reply-only-executed` |

当前结果：**22/22 passed**。脚本每次运行会先打印上面这张覆盖清单，
数据集里少了对应用例会直接判失败。

## 10. ReAct vs Plan-and-Execute 对比

同一个任务分别跑两条链路，量五项：**模型调用次数、工具调用次数、首字延迟、总延迟、成功率**。

| 指标 | ReAct | Plan-and-Execute |
| --- | ---: | ---: |
| 模型调用次数 | 待实测 | 待实测 |
| 工具调用次数 | 待实测 | 待实测 |
| 首字延迟 | 待实测 | 待实测 |
| 总延迟 | 待实测 | 待实测 |
| 成功率 | 待实测 | 待实测 |
| 计划可见 | 否 | 是 |
| 失败可定位 | 较弱 | 较强 |

跑法（需要真实模型）：

```bash
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
npm run eval:plan -- --compare
```

脚本会对每个「复杂任务」样本各跑一次 ReAct 与 Plan（Plan 侧强制 `mode=plan`，
避免分类器把它判回 ReAct），并打印可直接粘进本节的 Markdown 表格。

最后两行不是「待实测」，它们是结构性的：

* **计划可见**：ReAct 里没有「计划」这个对象，计划模式里第一步执行前就能拿到；
* **失败可定位**：ReAct 只有一条消息流，Plan 有步骤级状态与错误码。

而延迟方向是相反的：ReAct 首字快、总时长短；Plan 要先规划再执行，
最终回答一次性输出，首字延迟天然更高。用 Plan 换的是可控性与可解释性。

## 11. 已知边界

* 知识库开启时，计划**必须**包含检索步骤（`invalid_plan`）。这是当前实现的硬约束，
  「检索步骤改为可选用」还没拍板。
* 前端没有自动化测试（仓库里没有前端测试框架），计划时间线目前靠人工验收。
* `--compare` 的数字与模型、温度、工具实现强相关，换模型要重测。

## 12. 回归与最终验收（步骤 12）

### 12.1 自动化结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| plan-execute 单测 + chatPlan 路由单测 | `npx tsx --test plan-execute/*.test.ts routes/chatPlan.test.ts` | **54 / 54 passed** |
| 类型检查 | `npm run typecheck` | ✅ 无错误 |
| 构建 | `npm run build` | ✅ 通过 |
| 离线评测（Mock 图 + 规则判分） | `npm run eval:plan` | **22 / 22 passed** |

`npm run eval:plan` 是**离线**的：不打模型、不调真实工具，用预置剧本跑完整张图再规则判分，
因此能进 CI；它验的是图与状态机，不是模型质量。

### 12.2 人工验收结论

| # | 验收点 | 结论 |
| --- | --- | --- |
| 1 | 简单问题不进 Planner | ✅ 分类器直接判 `single_step` / `too_ambiguous`，Planner 未被调用 |
| 2 | `mode=auto` 的实际走向 | ⚠️ 该问题被判回 ReAct；**切到 plan 模式**才走完两步 |
| 3 | 多步任务按计划顺序执行 | ✅ 三步按计划顺序跑完 |
| 4 | Re-plan 次数 | ✅ 最多 1 次（`MAX_REPLAN=1`） |
| 5 | 步骤内只用本步白名单工具 | ✅ 没有替代工具被塞进步骤 |
| 6 | 失败步骤之后的步骤不再执行 | ✅ 第三步未执行 |
| 7 | 计划状态存储 | ✅ 只在内存 `planState`，**不写 localStorage**，刷新不污染历史 |

### 12.3 受阻项（当前环境无法完成）

| 项目 | 受阻原因 |
| --- | --- |
| `npm run eval:chat` / `npm run eval:multi` / `eval:plan --compare` | 需要真实模型，沙箱无外网，联网授权未通过 |
| 浏览器端点验 | 需要启动前后端服务，沙箱不允许监听端口 |

这两类项**不是失败**，只是没能在本机跑完；结论以 §12.1 的自动化结果和
§12.2 的人工验收为准。补测时按 `tasks/plan-and-execute-plan.md` 的步骤 12 清单走即可。
