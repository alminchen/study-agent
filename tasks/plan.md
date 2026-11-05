# 进阶学习计划执行手册

> 范围：`advanced-learning-plan.md` 中的 10 个进阶方向。本文中“进阶学习计划”指这 10 项整体，
> 不另设阶段编号，也不包含主线阶段 5、RAG 上传应用、Bug 分析作品集等未完成项。
>
> 当前状态：10 项中第 1 项“Streaming 结构化输出”的阶段学习、代码实现和文档
> 沉淀已完成；运行实测仍待授权。其余 9 项尚未开始。

## 怎么使用这份计划

1. 一次只选 1 项，最多并行 2 项互不依赖的学习方向。
2. 每项都按“先读现有链路 -> 定义契约 -> 写失败用例 -> 做后端 -> 接前端 -> 跑回归”的顺序执行。
3. 每一步都要能看到实际文件变化；只写笔记不勾选实现任务。
4. 每项结束后必须同时满足功能、失败路径、测试和文档四类验收。
5. 推荐先做“Streaming 结构化输出”，再直接做“Plan-and-Execute”。
6. 未经用户点名，不开始后续方向，不一次性铺开多个端点或页面。

## 当前代码事实

| 方向 | 现有基础 | 真正缺口 |
| --- | --- | --- |
| Streaming 结构化输出 | SSE 已有 `delta`、`trace`、`usage`、`[DONE]` | 模型请求固定 `stream: false`，只有最终文本被分块下发；没有 partial JSON |
| 长上下文管理 | `clipMessages` 保留最近消息，`/api/chat` 传入 `maxContextMessages: 8` | 只按条数裁剪，没有 token 预算、摘要和压缩状态 |
| Vision | 消息内容统一是字符串 | `TextMessage.content`、前端 `ChatMessage.content` 都不支持图片 content parts |
| Memory | 前端 `localStorage` 保存当前会话历史 | 服务端没有跨会话用户记忆、检索、CRUD 和隐私控制 |
| LLM-as-Judge | `inputGuard` 正则检测，`outputGuard` system prompt 指纹检测 | 没有语义 Judge、结构化判定和误报/漏报对比 |
| Reflection | ReAct 图在最终 `reply` 直接结束 | 没有 Critic、评分阈值、修订重试和无改进停止 |
| Plan-and-Execute | 已有 `askModel ↔ applyTools -> reply` ReAct 图 | 没有任务分类、Planner、Executor、受控 Re-plan |
| Tool 动态发现 | `server/tools/index.ts` 手工汇总工具清单 | Guard、MCP、Worker 各自维护硬编码名字，新增工具需要多处修改 |
| 前端 Agent 框架对比 | 前端手写 `fetch`、SSE parser、状态和停止逻辑 | 没有 Vercel AI SDK / LangChain.js 的同场景对比与采用结论 |
| AB 测试 / 在线 Evals | 有离线规则 Evals 和 JSON 用量记录 | 没有实验分流、请求级关联、用户反馈和在线指标 |

## 推荐执行顺序

| 顺序 | 项目 | 为什么现在做 | 前置 |
| --- | --- | --- | --- |
| 1 | Streaming 结构化输出 | 后续 Planner、Judge、Reflection 都需要可靠结构化结果 | 无 |
| 2 | Plan-and-Execute | 可复用 ReAct、工具确认和过程面板，能形成最明显的 Agent 能力升级 | 第 1 项 |
| 3 | 长上下文管理 | 直接修复 8 条消息硬截断导致的早期信息丢失 | 第 1 项 |
| 4 | Vision | 适合做前端助手作品集，但会同时改消息协议和 UI | 长上下文的消息协议确定后更稳 |
| 5 | Tool 动态发现 | 现有详细设计文档已经足够，可作为低风险工程改造 | 无 |
| 6 | LLM-as-Judge | 需要先有结构化判定和评测数据集 | 第 1 项 |
| 7 | Reflection | 依赖结构化评分，并应与 Judge 明确分层 | 第 1、6 项 |
| 8 | Memory | 涉及持久化、隐私和上下文注入，放在上下文能力之后 | 第 3 项 |
| 9 | 前端 Agent 框架对比 | 结构化输出和前端状态稳定后再比较才有意义 | 第 1 项 |
| 10 | AB 测试 / 在线 Evals | 最后做统一的 requestId、反馈、指标和实验分流 | 至少完成一个可比较变体 |

## 通用完成标准

每项功能只有在以下条件都满足时才算完成：

- 新增能力有单独入口或明确开关，不静默改变现有三条聊天链路。
- 至少有一个“正常路径”和一个“失败/中止路径”的自动测试。
- SSE 新增事件有 TypeScript 类型，前端遇到未知事件不会崩溃。
- 请求中止后会停止模型调用、工具执行和后续写入。
- Token 用量、错误和降级原因能在 trace 或日志中定位。
- `npm run typecheck` 和 `npm run build` 通过。
- 涉及真实模型能力时，至少跑一次对应 Evals；没有 API Key 时明确记录未运行。
- `tasks/todo.md` 勾选完成项，并写明实际验证结果。

所有命令默认在 `step1-chat/` 下执行：

```bash
npm run typecheck
npm run build
```

需要真实模型的命令先检查：

```bash
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
npm run eval:chat
npm run eval:multi
```

---

## 1. Streaming 结构化输出

> 专项学习与执行手册：`tasks/streaming-structured-output-plan.md`。

**学习目标**

- 理解普通文本 SSE、模型原生 token stream、partial JSON 三者不是同一件事。
- 理解 JSON mode 只保证“最终是 JSON”，不保证每个网络 chunk 都是可解析 JSON。
- 学会用 Zod 校验最终结构，并对未闭合字符串、转义字符和数组中间态做容错。
- 比较手写 parser 与 Vercel AI SDK `useObject` 的代码量、错误处理和控制力。

**前置**

- 能解释 `/api/chat` 当前为什么不是真正的模型 token stream。
- 已阅读 `server/react/complete.ts`、`server/routes/sse.ts`、`src/api/chat.ts`、`src/composables/useChat.ts`。

**执行步骤**

1. 写一页对照笔记，分别画出“供应商 JSON 流”“服务端 SSE”“前端 Vue 状态”三层数据变化。
2. 首版只支持 `table` 与 `code` 两种 block，定义 Zod discriminated union：
   `StructuredResult = { type: "table"; columns; rows } | { type: "code"; language; content }`。
3. 在 `server/structured/types.ts` 定义 SSE 事件：`structured_start`、`structured_delta`、
   `structured_snapshot`、`structured_done`、`error`、`usage`、`[DONE]`。
4. 先写 fixture 和纯函数测试，不接模型。覆盖普通对象、表格逐行增长、未闭合字符串、
   转义引号、嵌套对象、截断数组和最终非法 JSON。
5. 在 `server/structured/parsePartialJson.ts` 实现或封装 partial JSON 解析；
   每次只返回“已通过最小 schema 校验的稳定快照”，不把随机中间字符串直接塞给组件。
6. 新增 `server/structured/complete.ts`，这里必须使用 `stream: true` 读取模型 chunk；
   开启供应商支持的 JSON mode，并在日志中记录模型、首字延迟、chunk 数和最终解析错误。
7. 新增 `POST /api/chat/structured`。复用现有 abort、UsageAccumulator 和 SSE headers，
   但不要改 `/api/chat` 的响应语义。
8. 前端新增独立 `streamStructured()`，在 `useChat` 里增加结构化模式；
   收到 `structured_snapshot` 后替换当前结构化 block，避免同一行重复追加。
9. 新增 `StructuredBlock.vue` 渲染表格/代码。表格固定列宽策略，窄屏允许横向滚动；
   代码块逐行出现并处理空语言标识。
10. 补齐失败回退：首字前失败显示可重试错误；中途失败保留最后一个稳定快照并明确标记“未完成”；
    客户端 abort 后不再写 usage 或成功历史。
11. 用固定 chunk fixture 跑自动测试，再用真实模型请求“生成一个三行对比表”。
12. 做 Vercel AI SDK `useObject` 最小 spike，记录依赖、代码行数、首字延迟、partial 更新方式、
    错误恢复和停止能力，最后给出“继续手写”或“引入 SDK”的结论。

**建议文件**

- 新增：`server/structured/types.ts`
- 新增：`server/structured/parsePartialJson.ts`
- 新增：`server/structured/parsePartialJson.test.ts`
- 新增：`server/structured/complete.ts`
- 新增：`server/routes/chatStructured.ts`
- 修改：`server/routes/index.ts`
- 修改：`server/usage/types.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 新增：`src/components/StructuredBlock.vue`
- 新增：`docs/structured-output.md`

**失败路径**

- 模型不支持 JSON mode 或返回 Markdown code fence。
- 网络中断发生在 JSON 字符串中间。
- 最终对象超出 schema，例如表格缺列或 code block 缺 language。
- 用户停止生成，前端仍收到迟到 chunk。
- partial parser 生成倒退快照，导致 UI 内容闪烁或重复行。

**验收标准**

- 表格在第一行完成时就能显示，而不是等全部响应结束。
- 只有最终对象通过 Zod 校验后才标记成功。
- 中途失败会保留稳定快照，并显著显示未完成状态。
- `/api/chat`、`/api/chat/multi`、`/api/rag/chat` 原有回归不变。
- 文档包含手写方案与 `useObject` 的实测对比。

**验证命令**

```bash
npx tsx --test server/structured/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
npm run eval:multi
```

---

## 2. Plan-and-Execute

> 专项执行手册：`tasks/plan-and-execute-plan.md`。

**学习目标**

- 理解 ReAct 适合边走边看、工具选择不确定的任务；Plan-and-Execute 适合步骤可预见的多步任务。
- 学会限制计划长度、重规划次数和单步执行轮数，避免成本与延迟失控。
- 学会把“计划状态”和“执行状态”作为显式数据，而不是藏在自然语言回复里。

**前置**

- 第 1 项能稳定输出并校验结构化对象。
- 已阅读 `server/react/runConversation.ts`、`server/react/applyToolCalls.ts`、
  `server/react/confirmGate.ts`、`server/multi-agent/graph.ts`。

**执行步骤**

1. 用 12 条样本定义简单/复杂任务边界。简单任务直接 ReAct；只有多来源查询、
   多步代码修改或“先调研再产出”才进入 Planner。
2. 定义 `PlanSchema`：`goal`、最多 6 个 `steps`、每步 `id/title/action/doneWhen/status`，
   另设单步最大字符数和整个任务最大模型轮数。
3. 在 `server/plan-execute/classify.ts` 实现可测试路由。先用规则/关键词加显式
   `mode: "auto" | "react" | "plan"`，不让分类器成为新的不可解释黑盒。
4. 新增 `POST /api/chat/plan`，建立独立 LangGraph：
   `classify -> planner -> executor -> maybe_replan -> reply`。
5. Planner 节点调用结构化输出生成计划，校验失败或步骤超限时回退现有 ReAct，
   并推送 `plan_fallback` trace。
6. Executor 顺序执行步骤。每步只拿到目标、当前步骤、已完成步骤摘要和允许的工具；
   不要每步重新发送完整无关聊天历史。
7. 每个需确认工具沿用现有 `ConfirmSession`。等待确认期间 SSE 保持打开；
   用户拒绝即终止该步，不允许 Re-plan 自动改成“绕过确认”的替代动作。
8. 单步失败时先判断是否可恢复。最多 Re-plan 1 次，新计划重新过 schema 与步骤上限；
   超时、用户拒绝、安全拦截和达到模型轮数上限都直接失败。
9. 定义 SSE 过程事件：`plan_created`、`plan_step_started`、`plan_step_done`、
   `plan_step_failed`、`plan_replanned`、`plan_finished`。
10. 前端在 `ToolTracePanel` 增加计划区，显示原始计划与 Re-plan 后的新计划，
    不覆盖旧计划。完成、失败、跳过状态必须由事件驱动。
11. 补 Evals：简单问题不得调用 Planner；复杂问题步骤有序；非法计划会回退；
    确认拒绝不会触发 Re-plan；Re-plan 最多一次。
12. 写 `docs/plan-and-execute.md`，用同一任务比较 ReAct 与 Plan-and-Execute 的调用次数、
    延迟、成功率和可解释性。

**建议文件**

- 新增：`server/plan-execute/types.ts`
- 新增：`server/plan-execute/classify.ts`
- 新增：`server/plan-execute/planner.ts`
- 新增：`server/plan-execute/executor.ts`
- 新增：`server/plan-execute/replan.ts`
- 新增：`server/plan-execute/graph.ts`
- 新增：`server/routes/chatPlan.ts`
- 修改：`server/routes/index.ts`
- 修改：`server/react/types.ts`
- 新增：`scripts/run-plan-evals.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 修改：`src/components/ToolTracePanel.vue`
- 新增：`evals/dataset-plan.json`
- 新增：`docs/plan-and-execute.md`

**失败路径**

- Planner 返回空计划、循环依赖或 10 个以上步骤。
- 某一步模型重复调用同一失败工具。
- 用户拒绝高风险工具后，Re-plan 尝试用其他工具完成同一后果。
- 客户端在执行第 3 步时断开。
- 新计划覆盖旧计划但 UI 没有留下替换原因。

**验收标准**

- 简单问题不额外调用 Planner。
- 计划在执行第一步前可见，每一步状态实时更新。
- Re-plan 最多一次，确认拒绝不可被绕过。
- 最终回答只能引用已执行步骤的真实结果。
- 中止后不再执行下一工具或下一次模型调用。

**验证命令**

```bash
npx tsx --test server/plan-execute/*.test.ts
npm run typecheck
npm run build
npx tsx scripts/run-plan-evals.ts
npm run eval:chat
npm run eval:multi
```

---

## 3. 长上下文管理

> 专项执行手册：`tasks/long-context-management-plan.md`。

**学习目标**

- 理解 context window、输入 token 成本、最近对话质量和摘要失真之间的关系。
- 掌握 Sliding Window + Summary 的混合策略。
- 学会设计可观察的压缩状态，让用户知道哪些轮次已经从原文变成摘要。

**前置**

- 已阅读 `server/clipMessages.ts`、`server/chat.ts` 和当前 `maxContextMessages: 8` 的调用点。
- 选定一种测试模型，并记录其上下文窗口与输入价格。

**执行步骤**

1. 为当前模型设置显式 token 预算，例如只使用上下文窗口的 50%～60%，
   给 system、工具结果和输出保留空间。
2. 在 `server/context/tokenBudget.ts` 实现保守估算器。首版可以使用
   “CJK 字符数 + 非 CJK 字符数/4 + 每条消息开销”的近似算法，但必须加安全余量并写测试。
3. 定义摘要结构 `{ facts, decisions, unresolved, userConstraints }`，
   用结构化输出生成，不允许只写一段无法验证的自由文本。
4. 把 `clipMessages` 改为分层选择：system 固定保留；最近 N 轮保留原文；
   更早消息在超过阈值时进入摘要；工具消息按配对完整性保留。
5. 摘要失败时回退到严格 token 窗口，不把未校验摘要注入模型。
6. 由于当前聊天接口无状态，新增请求字段 `contextSummary` 和 SSE 事件
   `context_compacted`。前端持久化摘要和 `compactedUntilMessageId`，下一轮再传回服务端。
7. 前端在发生压缩时显示“已压缩 N 轮对话”，并允许展开查看摘要摘要，不显示敏感推理。
8. 对工具调用消息做配对检查，禁止留下孤立的 assistant tool_calls 或 tool result。
9. 增加 50+ 轮固定脚本：第 3 轮写入唯一事实，第 50 轮后要求回答该事实；
   同时测试无摘要、摘要成功、摘要失败三条路径。
10. 记录每轮原始输入 token、压缩后 token、摘要调用 token 和最终回答质量。

**建议文件**

- 修改：`server/clipMessages.ts`
- 新增：`server/context/tokenBudget.ts`
- 新增：`server/context/summarize.ts`
- 新增：`server/context/buildContext.ts`
- 修改：`server/chat.ts`
- 修改：`server/routes/chat.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 新增：`src/components/ContextCompactionNotice.vue`
- 新增：`scripts/test-long-context.ts`

**失败路径**

- 中英文混合导致估算偏低。
- 摘要重复或漏掉第 3 轮的关键约束。
- 工具调用与被调用结果被截到不同窗口。
- 摘要调用次数过多，成本高于直接裁剪。
- 旧历史没有 `contextSummary` 字段。

**验收标准**

- 50+ 轮后仍能引用第 3 轮的唯一事实和用户约束。
- 注入 token 不超过配置预算。
- 工具消息始终成对。
- 摘要失败自动回退且不阻断聊天。
- UI 能说明已压缩范围，旧历史可正常加载。

**验证命令**

```bash
npx tsx --test server/context/*.test.ts
npx tsx scripts/test-long-context.ts
npm run typecheck
npm run build
npm run eval:chat
```

---

## 4. Vision（图片输入）

**学习目标**

- 理解 OpenAI 兼容多模态消息的 `text + image_url` content parts。
- 理解 base64 data URL、远程 URL、图片大小、MIME 和隐私边界。
- 学会把“截图分析”做成完整纵向场景，而不是只让接口能收一张图。

**前置**

- 确认目标模型支持图片输入，并记录图片计费规则。
- 已阅读 `server/react/types.ts`、`server/react/complete.ts`、`src/types.ts`、`src/composables/useChat.ts`。

**执行步骤**

1. 先定义共享概念：`ChatContentPart = text | image_url`，只允许 user 消息使用图片；
   assistant/tool 消息保持现有结构，避免破坏 tool_calls 协议。
2. 在 `server/react/types.ts` 把普通 `TextMessage.content` 改为 content union，
   同时保留纯文本辅助函数，减少所有调用点改动。
3. 前端 `ChatMessage` 增加 `attachments`，不要把 base64 混进正文；历史记录可只存
   文件名、MIME、尺寸和来源，避免 localStorage 膨胀。
4. 在输入框增加上传与粘贴。首版限制 1 张、PNG/JPEG/WebP、最大 5 MB，
   显示缩略图并支持移除；提交前校验，失败给出具体原因。
5. 后端在路由层再次校验 MIME、大小和 data URL 格式，不能只信前端。
6. 修改模型请求适配层，把图片转成供应商要求的 `image_url` content part；
   不支持的模型直接禁用 Vision 模式，而不是运行到 API 才报错。
7. 做一个完整场景：“粘贴 UI 截图 -> 识别布局层级 -> 指出 3 个问题 -> 给出修复建议”。
   提示词要求区分“截图中可见”和“推测”。
8. 记录图片宽高、MIME、估算或实际图片 token、总 usage；在成本面板标记图片请求。
9. 默认不把原图写入服务端 usage 日志；前端清除会话时同步删除附件引用。
10. 增加图片 fixture 和真实模型手工验收。自动测试重点覆盖协议转换、大小校验和 abort。

**建议文件**

- 修改：`server/react/types.ts`
- 修改：`server/react/complete.ts`
- 修改：`server/chat.ts`
- 修改：`server/routes/chat.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 修改：`src/App.vue`
- 修改：`src/components/ChatMessageItem.vue`
- 新增：`src/components/ImageAttachment.vue`
- 新增：`server/vision/validateImage.ts`
- 新增：`docs/vision.md`

**失败路径**

- 浏览器粘贴剪贴板图片时没有文件名或 MIME。
- data URL 超出请求体限制。
- 模型不支持图片或图片 token 超限。
- 旧历史中有文本 content，新代码误按数组解析。
- 用户在流式生成中删除附件或停止请求。

**验收标准**

- 能粘贴一张 UI 截图并得到引用截图内容的结构化分析。
- 文本链路和工具调用链路不因 content union 改坏。
- 超过大小、格式错误、模型不支持时有明确提示。
- 图片不进入 usage 日志正文，清空会话后不残留可恢复 data URL。

**验证命令**

```bash
npx tsx --test server/vision/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
```

---

## 5. Memory（跨会话记忆）

**学习目标**

- 区分事实记忆（结构化 KV）与语义记忆（向量检索）。
- 学会抽取、去重、置信度、检索注入、删除和隐私控制。
- 理解“保存聊天历史”不等于“模型拥有长期记忆”。

**前置**

- 第 3 项的上下文注入协议已经稳定。
- 明确匿名用户标识来源，不采集姓名、邮箱等不必要的 PII。

**执行步骤**

1. 先只做事实记忆，不做向量库。定义 `MemoryFact`：
   `id/userId/key/value/source/confidence/createdAt/updatedAt/expiresAt`。
2. 使用独立 `data/memory.json` 或本地 SQLite 做 demo 持久化；一定要有时间戳、
   最大条数、原子写入和损坏文件回退。不可与 `usage-log.json` 混存。
3. 新增 API：`GET /api/memory`、`POST /api/memory`、`PATCH /api/memory/:id`、
   `DELETE /api/memory/:id`、`DELETE /api/memory`。
4. 前端生成稳定匿名 `memoryUserId`，只用于记忆命名空间；服务端所有查询必须带该 ID。
5. 首版抽取只接受明确偏好，例如“以后回答都用中文”“项目使用 Vue 3”，
   使用结构化输出返回 `shouldStore/confidence/key/value/reason`。
6. 低置信度、敏感信息、临时任务和一次性的格式要求不写入长期记忆。
7. 新请求只注入与当前问题相关的前 5 条事实；每条带短 ID，
   方便回答中说明使用了哪些记忆。无关记忆不得全量塞进 system。
8. 增加 Memory 管理面板：查看、编辑、删除、全部清空和开关“允许长期记忆”。
9. 完成事实记忆后，再做语义记忆 spike：复用现有 embedding，但使用独立 collection，
   设置相似度阈值和 Top-K；效果不如事实记忆时明确停止，不强行上向量库。
10. 增加跨会话测试：会话 A 保存事实，完全新开会话 B 仍能使用；删除后下一次请求立即失效。

**建议文件**

- 新增：`server/memory/types.ts`
- 新增：`server/memory/store.ts`
- 新增：`server/memory/extract.ts`
- 新增：`server/memory/retrieve.ts`
- 新增：`server/routes/memory.ts`
- 修改：`server/routes/index.ts`
- 修改：`server/chat.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 新增：`src/components/MemoryPanel.vue`
- 新增：`docs/memory.md`

**失败路径**

- 模型把临时要求误存成永久偏好。
- 同一事实重复写入或新旧值冲突。
- 多用户 ID 串数据。
- `memory.json` 并发写损坏。
- 用户关闭记忆后历史记忆仍被注入。

**验收标准**

- 跨会话能记住一条明确偏好，并能说明来源。
- 用户可查看、编辑、删除和全部关闭。
- 关闭后新请求不再注入任何记忆。
- 敏感信息和低置信度内容不会自动写入。
- 存储损坏时聊天继续工作并记录可诊断错误。

**验证命令**

```bash
npx tsx --test server/memory/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
```

---

## 6. LLM-as-Judge

**学习目标**

- 理解规则 Guard 与语义 Judge 的召回、误报、延迟和成本差异。
- 学会先做评测数据集，再决定 Judge 是否上线。
- 学会用结构化输出约束分类结果，并采用 shadow 模式降低直接误伤风险。

**前置**

- 第 1 项的结构化输出稳定。
- 已阅读 `server/guard/inputGuard.ts`、`server/guard/outputGuard.ts` 和 Guard trace 事件。

**执行步骤**

1. 先建立 `evals/judge-dataset.json`，覆盖直接注入、改写注入、间接文档注入、
   安全研究类正常问题、普通越权请求、system prompt 泄露回复和正常回复。
2. 为每条样本标注 `expectedRisk` 与 `category`。不能只用规则 Guard 命中的样本当正例，
   否则数据集会天然偏向旧规则。
3. 定义 Judge schema：`risk: safe|suspicious|unsafe`、`categories`、`confidence`、
   `shortReason`。不要求模型输出长 chain-of-thought。
4. 增加 Guard 模型配置，但复用独立模型名、温度、超时和价格配置，不能悄悄使用主模型。
5. 在 `server/guard/judge.ts` 实现 mockable judge；模型错误、超时或非法 JSON
   返回 `unknown`，调用方按显式策略处理。
6. 先只做 shadow：输入 Judge 结果写入 trace 和评测记录，不改变主回答。
7. 对比正则与 Judge 的 precision、recall、false positive、延迟和单次成本。
   高误报时继续 shadow，不直接 enforce。
8. 达到阈值后再做 `GUARD_JUDGE_MODE=off|shadow|enforce`。enforce 下高危输入拒绝，
   medium 只标记；拒绝文案不泄露判定规则细节。
9. Output Judge 在最终文本发出前检查合规和 system prompt 泄露；
   只返回风险与替换建议，不重写业务答案。
10. 加固定 fixture 单测和真实模型评测，记录模型版本，避免换模型后指标不可复现。

**建议文件**

- 新增：`evals/judge-dataset.json`
- 新增：`server/guard/judge.ts`
- 新增：`server/guard/judgeSchema.ts`
- 新增：`scripts/run-judge-evals.ts`
- 修改：`server/guard/inputGuard.ts`
- 修改：`server/guard/outputGuard.ts`
- 修改：`server/chat.ts`
- 修改：`server/runtimeConfig.ts`
- 修改：`server/react/types.ts`
- 修改：`src/types.ts`
- 新增：`docs/llm-judge.md`

**失败路径**

- Judge 被输入中的指令反向操控。
- Judge JSON 非法或请求超时。
- 安全研究问题被过度拦截。
- 规则和 Judge 都判安全，但输出确实泄露 system prompt。
- shadow 记录包含敏感原文。

**验收标准**

- 有一张正则 vs Judge 的可复现实测表。
- shadow 模式不改变主回答，只记录判定。
- enforce 模式有明确阈值、超时和失败策略。
- 误报率、漏报率、延迟、成本均可从记录中计算。
- 日志默认脱敏，模型版本可追溯。

**验证命令**

```bash
npx tsx --test server/guard/*.test.ts
npx tsx scripts/run-judge-evals.ts
npm run typecheck
npm run build
```

---

## 7. Reflection（回答自评与一次修订）

**学习目标**

- 区分 Reflection、LLM-as-Judge 和工具失败重试。
- 学会用固定 rubric 判断“是否值得重写”，并设置硬重试上限。
- 学会用 Evals 证明 Reflection 提升质量，而不是只增加一轮成本。

**前置**

- 第 1 项能输出结构化 Critic 结果。
- 第 6 项已说明 Judge 只做安全判定；Reflection 只做质量改进，两者不复用同一个提示词。

**执行步骤**

1. 选择只针对最终答案的 rubric：相关性、完整性、事实依据、清晰度。
   工具执行正确性不交给 Reflection 判断。
2. 定义 `CritiqueSchema`：四项 1～5 分、问题列表、是否建议重写、
   `revisionInstructions`、`reason`。
3. 新增独立 `POST /api/chat/reflection`。先生成 draft，再评估；不要直接改现有 ReAct 图。
4. 首版阈值设为“任一维度 <= 3 或存在 groundedness 问题”才重写。
5. 重写最多 1 次，且 Critic 不能调用工具；重写只拿到原问题、工具事实、draft 和修订指令。
6. 第二次评分如果不高于第一次，返回第一版或较优版本，禁止继续循环。
7. 推送 `reflection_scored`、`reflection_revised`、`reflection_skipped` trace，
   前端只在调试面板展示评分，不把 rubric 当正文。
8. 对同样输入做 A/B 离线对比：原答案 vs Reflection 答案，
   记录质量评分、延迟、token 和成本。
9. 如果 Evals 没有稳定提升，保留端点作为实验能力，不并入默认聊天。
10. 文档说明自我评估偏差：同一模型自评可能偏好自己的表达，不等同于人工质量保证。

**建议文件**

- 新增：`server/reflection/types.ts`
- 新增：`server/reflection/critic.ts`
- 新增：`server/reflection/revise.ts`
- 新增：`server/routes/chatReflection.ts`
- 修改：`server/routes/index.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 修改：`src/components/ToolTracePanel.vue`
- 新增：`evals/dataset-reflection.json`
- 新增：`docs/reflection.md`

**失败路径**

- Critic 返回模糊建议，导致重写后更差。
- 重写引入原工具结果不支持的新事实。
- 两个版本分数相同但内容大幅变化。
- 成本翻倍但离线 Evals 无提升。
- 用户停止时仍在执行第二次评分。

**验收标准**

- 最多 1 次修订，无改进立即停止。
- 重写版本不引入工具事实之外的新依据。
- trace 清楚显示是否评分、是否重写、为什么停止。
- 有原版与 Reflection 的成本/质量对比，未证明收益时不默认启用。

**验证命令**

```bash
npx tsx --test server/reflection/*.test.ts
npx tsx scripts/run-reflection-evals.ts
npm run typecheck
npm run build
```

---

## 8. Tool 动态发现

**学习目标**

- 区分“服务端发现工具模块”和“模型运行时选择工具”。
- 学会从唯一注册表派生 Guard 白名单、MCP 注册、Chat schema 和 Worker 可见集。
- 学会用 tag/策略限制工具暴露，而不是把所有工具无差别交给所有 Agent。

**前置**

- 已完整阅读 `docs/dynamic-tool-discovery.md`。
- 已盘点 `server/tools/index.ts`、`server/guard/toolCallGuard.ts`、
  `server/mcp/createServer.ts` 和 Worker 中的硬编码工具名。

**执行步骤**

1. 先不改目录，增加 `listToolNames()`，把 `toolCallGuard` 的硬编码白名单改为从注册表派生。
2. 定义 `ToolModule`：`name/schema/run/tags/risk/includeInDefaultChat/mcpInputSchema`。
3. 把现有天气、时间、知识库、人工确认假工具逐步迁入
   `server/tools/modules/<name>/index.ts`，每迁一个就保持旧 API 行为不变。
4. 实现 `discoverTools()` 只扫描固定目录，动态 import 模块并校验：
   `name === schema.function.name`、`run` 是函数、名字唯一、tag 合法。
5. 发现失败时启动直接退出并打印模块路径和缺失字段，不允许静默跳过。
6. 让 `toolSchemasForChat`、`findTool`、MCP 注册循环和 Worker 可见集都读发现结果。
7. 把 Chat 默认暴露、Realtime Worker、KB Worker 的可见规则写成显式 tag/配置；
   自动发现只解决清单同步，不解决权限边界。
8. 加结构测试：新增一个测试工具模块后，不改 `tools/index.ts`、
   `toolCallGuard.ts`、`mcp/createServer.ts` 和 Agent 图，也能被正确发现。
9. 加负向测试：缺 `run`、重名、schema 名字不一致、目录外 import 都被拒绝。
10. 记录启动时工具发现日志：发现数量、名称、tags、风险级别和 MCP 暴露状态。

**建议文件**

- 修改：`server/tools/types.ts`
- 新增：`server/tools/discover.ts`
- 新增：`server/tools/registry.ts`
- 修改：`server/tools/index.ts`
- 新增：`server/tools/modules/getWeather/index.ts`
- 新增：`server/tools/modules/getCurrentTime/index.ts`
- 新增：`server/tools/modules/searchDocs/index.ts`
- 新增：`server/tools/modules/draftMessage/index.ts`
- 修改：`server/guard/toolCallGuard.ts`
- 修改：`server/mcp/createServer.ts`
- 修改：`server/multi-agent/workers/realtimeWorker.ts`
- 修改：`server/multi-agent/workers/kbWorker.ts`
- 新增：`server/tools/discover.test.ts`

**失败路径**

- 动态 import 路径在实际部署目录不存在。
- 模块初始化抛错导致整个服务不可用。
- 工具重名时悄悄覆盖。
- Worker 发现到不该看到的工具。
- MCP 与 Chat 的输入 schema 不一致。

**验收标准**

- 新增工具只需要增加一个 module 目录并补测试。
- Guard 白名单、MCP 和 Chat schema 不再手抄工具名。
- Worker 仍按显式策略隔离工具。
- 非法模块让启动失败并给出清晰错误。
- 现有工具调用、人工确认和 MCP ping 全部回归通过。

**验证命令**

```bash
npx tsx --test server/tools/*.test.ts
npm run typecheck
npm run build
npm run mcp:ping
npm run eval:chat
npm run eval:multi
```

---

## 9. 前端 Agent 框架对比

**学习目标**

- 理解手写 SSE 状态机与 Vercel AI SDK `useChat` / `useObject` 的能力边界。
- 理解 LangChain.js 浏览器端与现有后端 LangGraph 的职责重叠和组合成本。
- 用同一业务场景做证据化选型，而不是先替换再找理由。

**前置**

- 第 1 项已有结构化端点，可用于 `useObject` 对比。
- 明确现有手写实现的基线：SSE 解析、停止、重试、工具确认、trace、usage。

**执行步骤**

1. 先记录现有手写方案基线：核心代码行数、依赖数、首字延迟、构建体积、
   停止/重试/错误/工具确认支持情况。
2. 建独立 `experiments/agent-sdk-compare/`，使用独立 `package.json`，
   不把实验依赖直接装进主应用。
3. 用 Vercel AI SDK `useChat` 接同一 `/api/chat` 或兼容 transport，
   完成普通文本、中止和错误展示。
4. 用 `useObject` 接第 1 项结构化端点，完成表格增量渲染。
5. 做 LangChain.js 浏览器端最小 spike：只验证它是否能接现有后端 SSE，
   不为对比重复实现完整的 Plan/Memory/Guard。
6. 用同一组 5 个场景测试：普通回答、工具调用、人工确认、结构化表格、网络中断。
7. 记录每个方案在相同场景下的代码量、依赖体积、错误可诊断性、
   SSE 自定义事件支持、工具确认改造量和 Vue 集成难度。
8. 用真实浏览器测首字时间、停止响应时间和构建后 JS 体积；
   记录测试环境和版本，避免只比较主观感受。
9. 输出 ADR：保留手写、采用某 SDK、或仅局部采用 `useObject`。
   未证明收益前，不迁移主分支。

**建议文件**

- 新增：`experiments/agent-sdk-compare/package.json`
- 新增：`experiments/agent-sdk-compare/src/App.vue`
- 新增：`experiments/agent-sdk-compare/src/useChatDemo.vue`
- 新增：`experiments/agent-sdk-compare/src/useObjectDemo.vue`
- 新增：`experiments/agent-sdk-compare/README.md`
- 新增：`docs/frontend-agent-framework-comparison.md`
- 可选修改主应用：只有在 ADR 明确通过后才改 `src/`

**失败路径**

- SDK 无法消费现有自定义 SSE 事件。
- `useObject` 对 partial schema 的要求与当前协议不兼容。
- 为接 SDK 修改后端协议，导致主应用回归。
- 实验依赖被误提交进主应用。
- 只比较代码量，不比较停止、错误和确认能力。

**验收标准**

- 三种方案在同一组场景下有可比记录。
- 有真实构建体积和浏览器测量数据。
- ADR 明确说明采用/不采用条件。
- 实验代码不进入主应用构建。
- 未获确认前主应用依赖和入口不变。

**验证命令**

```bash
cd experiments/agent-sdk-compare
npm install
npm run build
cd ../..
npm run typecheck
npm run build
```

---

## 10. AB 测试 / 在线 Evals

**学习目标**

- 区分离线 Evals 与线上实验：前者验证已知用例，后者观察真实分流和反馈。
- 学会稳定分流、requestId 关联、反馈采集和最小指标看板。
- 学会控制实验样本、版本和隐私，不从少量点赞直接下结论。

**前置**

- 已有可比较的两种 prompt、模型或功能变体。
- 第 1、2、6、7 项至少一项已完成，才能有有意义的实验对象。

**执行步骤**

1. 先定义实验配置：`experimentId`、变体权重、`promptVersion`、model、
   开始/结束时间和最小样本数。
2. 为每次请求生成 `requestId`，并让 usage、trace、反馈都记录同一 ID。
3. 前端生成不含 PII 的匿名 `clientId`，服务端用 hash 稳定分流；
   同一用户在同一实验内固定变体，避免来回跳。
4. 把当前内嵌 system prompt 抽成显式版本注册表。
   实验只能从已登记版本里选，不允许在路由里散落字符串。
5. 在 SSE 首个事件返回 `{ requestId, experimentId, variant }`，
   前端保存到当前 assistant 消息，用于反馈关联。
6. 增加评价按钮 thumbs up/down；down 可选原因
   `incorrect/tool_failed/unclear/unsafe/other`，不强制填写正文。
7. 新增 `POST /api/feedback`，校验 requestId/variant 和评分枚举，写入独立
   `data/online-evals.json` 或 demo 存储；禁止覆盖已有同 requestId 反馈。
8. 指标页按 variant 汇总：请求数、成功率、错误率、P50/P95 延迟、
   平均 token/成本、工具成功率、点赞率和反馈原因分布。
9. 加最小样本门槛提示；未达到样本数时只显示“数据不足”，不宣布胜出。
10. 提供离线 Evals 与在线结果对照页，说明两者结论冲突时先检查流量、模型版本和样本偏差。
11. 加确定性分流测试、重复反馈测试、删除/导出反馈测试和敏感字段脱敏测试。

**建议文件**

- 新增：`server/experiments/config.ts`
- 新增：`server/experiments/assign.ts`
- 新增：`server/prompts/registry.ts`
- 新增：`server/online-evals/store.ts`
- 新增：`server/routes/feedback.ts`
- 新增：`server/routes/experiments.ts`
- 修改：`server/routes/chat.ts`
- 修改：`server/routes/chatMulti.ts`
- 修改：`server/usage/types.ts`
- 修改：`server/usage/store.ts`
- 修改：`src/types.ts`
- 修改：`src/api/chat.ts`
- 修改：`src/composables/useChat.ts`
- 新增：`src/components/FeedbackButtons.vue`
- 新增：`src/components/ExperimentMetricsPanel.vue`
- 新增：`docs/online-evals.md`

**失败路径**

- 同一 clientId 刷新后变体改变。
- 请求失败或中止后没有成功/延迟记录。
- 反馈找不到 requestId 或伪造 variant。
- 不同 prompt 版本无法从日志追溯。
- 点赞数据太少就得出“模型 B 更好”。
- 反馈原因或聊天正文泄露敏感信息。

**验收标准**

- 同一 clientId 对同一实验始终进入同一变体。
- 每次请求都能从 SSE 到 usage 到反馈串起来。
- 指标按变体和版本可从 UI 与 API 查询。
- 样本不足有明确提示，不误导结论。
- 反馈默认不记录正文，支持删除和脱敏。

**验证命令**

```bash
npx tsx --test server/experiments/*.test.ts server/online-evals/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
npm run eval:multi
```

---

## 依赖关系

```text
Streaming 结构化输出
    ├── Plan-and-Execute
    ├── LLM-as-Judge ── Reflection
    ├── Memory（结合长上下文注入）
    └── 前端框架对比（useObject 场景）

长上下文管理
    └── Memory（上下文预算与注入）

Tool 动态发现
    └── 可独立完成，也可作为 Plan Executor 的工具基础

AB 测试 / 在线 Evals
    └── 至少依赖一个可比较变体，并应统一 requestId、usage、trace、feedback
```

## 检查点

### 检查点 1：结构化输出完成

- [ ] partial JSON 测试与最终 schema 校验通过。
- [ ] 前端能逐行显示表格，错误路径可重试。
- [ ] 三条既有聊天链路回归通过。
- [ ] 用户确认后再开始 Plan-and-Execute。

### 检查点 2：Plan-and-Execute 完成

- [ ] 简单问题仍走 ReAct。
- [ ] 复杂任务有计划、步骤状态和一次受控 Re-plan。
- [ ] 人工确认拒绝不可绕过。
- [ ] 类型检查、构建和相关 Evals 通过。

### 检查点 3：上下文与图片完成

- [ ] 50+ 轮仍能引用第 3 轮事实。
- [ ] 工具消息保持配对，摘要失败可回退。
- [ ] 图片协议、校验、成本与隐私路径可用。
- [ ] 旧历史兼容。

### 检查点 4：高级能力完成

- [ ] Memory、Judge、Reflection、动态工具各自有正常/失败测试。
- [ ] LLM-as-Judge 与 Reflection 职责没有混用。
- [ ] 新增工具不需要修改多份硬编码清单。

### 检查点 5：实验与在线 Evals 完成

- [ ] 框架对比有 ADR 和真实数据。
- [ ] AB 分流稳定，requestId 可关联 usage/trace/feedback。
- [ ] 指标页按 variant 展示并提示最小样本。

## 不属于进阶学习计划

以下任务仍需完成，但不要混入上述 10 项：

- 阶段 5 交付页：调试页、日志页、成本页和 Evals 交付。
- RAG 上传文档完整应用。
- Bug 分析作品集。
- 需求转代码作品集。
- 全部学习结束后的工程优化与逻辑清理。

## 决策规则

- 用户点名哪一项，就只把该项展开为当轮实现任务。
- 如果有更简单且可验证的方案，先写清 trade-off 再替换计划，不擅自改范围。
- 如果某项实现成本明显超过学习收益，保留 spike 和结论，不强推生产接入。
- 如果 Evals 证明能力没有收益，记录结果并停止默认启用。
