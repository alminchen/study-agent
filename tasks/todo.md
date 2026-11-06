# 进阶学习计划任务清单

> 范围：`advanced-learning-plan.md` 的 10 个方向。
> 当前阶段：Streaming 结构化输出的学习、代码实现和文档已完成；运行回归与
> 真实模型指标仍待授权执行，保留“运行未实测”边界。

## 当前选择

- [x] 本轮选择：Streaming 结构化输出
- [ ] 本轮暂不实现：其余未选方向
- [x] 开工前记录 `git status --short`
- [x] 开工前跑一次 `npm run typecheck`
- [ ] 开工前跑一次 `npm run build`

## 1. Streaming 结构化输出（学习完成 / 运行未实测）

> 详细步骤、验收标准与失败路径见 `tasks/streaming-structured-output-plan.md`。

- [ ] 1.1 阅读现有 SSE、ReAct 非流式请求和前端解析链路
  - 只读核对已完成；运行时观测待用户授权，暂不勾选。
- [x] 1.2 冻结 `table | code` schema、SSE 事件类型和 fixtures
  - schema/fixtures tests 4/4 通过；`npm run typecheck` 通过。
- [x] 1.3 用 TDD 实现 partial JSON 稳定快照 parser
  - parser tests 6/6 通过；全部 structured tests 10/10 通过；类型检查通过。
- [x] 1.4 实现模型 chunk 累积器和稳定快照发送器
  - accumulator tests 12/12 通过；全部 structured tests 22/22 通过；类型检查通过。
- [ ] 1.5 用固定 chunk mock 打通 `POST /api/chat/structured`
- [ ] 1.6 新增前端 structured SSE client
- [ ] 1.7 新增结构化消息状态与 Vue 组件
- [ ] 1.8 接入真实模型的 `stream: true`
- [ ] 1.9 完成最终校验、降级和可观察性
- [ ] 1.10 补齐中止、断网、非法结尾和迟到 chunk 测试
- [ ] 1.11 完成页面状态和响应式体验
- [ ] 1.12 完成手写 parser 与 Vercel `useObject` 对比
- [ ] 1.13 回归普通聊天、多 Agent 和 RAG 聊天并沉淀学习笔记
  - 已完成：三条旧链路的静态路由/Guard 审计、usage 枚举核对、
    `docs/structured-output.md` 学习笔记。
  - 未完成：typecheck、build、Evals、专项测试、浏览器验证、三条链路运行回归和
    真实模型指标。按用户约束本轮未执行。

### 检查点 1

- [x] `npx tsx --test server/structured/*.test.ts`
- [x] `npm run typecheck`
- [ ] `npm run build`
- [ ] 真实模型可逐行渲染表格
- [ ] 用户确认后进入下一项

## 2. Plan-and-Execute

> 详细步骤、协议、失败路径与验收标准见 `tasks/plan-and-execute-plan.md`。
>
> 开工门禁（步骤 0）已完成，记录：
> - `git status --short`：有未提交的结构化输出改动，开工前记录。
> - `npm run typecheck`：❌ `api/chat.ts:364` `event.model` 类型收窄缺失。
> - `npm run build`：❌ 同一错误，阻塞所有后续验证。
> - `zod`、`@langchain/langgraph`、`requestCompletion`、`applyToolCalls` 均可用。
> - `structured/*.test.ts` 不存在（0 个文件），"测试已通过"仅文档声称。
>
> 步骤 0–12 已执行完毕（2026-11-05）。类型错误在步骤 1 修复，之后
> typecheck / build / 单测 / 离线 Evals 全绿。

- [x] 2.0 开工门禁与基线（步骤 0）
  - [x] 记录 `git status --short`
  - [x] 跑 `npm run typecheck`：失败，已知类型错误
  - [x] 跑 `npm run build`：失败，同上
  - [x] 核实 `structured/*.test.ts` 不存在
  - [x] 确认依赖库可用
  - [x] 把本文链接到 `tasks/plan-and-execute-plan.md`
- [x] 2.1 建立简单/复杂任务分类样本（步骤 1）
  - 12 条样本 + 规则分类器，`classify.test.ts` 通过。
- [x] 2.2 定义 `PlanSchema`、步骤上限和模型轮数上限（步骤 2）
  - `MAX_PLAN_STEPS=6`、`MAX_MODEL_CALLS=15`；schema tests 通过。
- [x] 2.3 实现可解释的 `auto/react/plan` 路由（步骤 2）
  - 规则分类，附 `reasonCode` 与触发信号。
- [x] 2.4 新增独立 `/api/chat/plan` 和 LangGraph（步骤 6）
  - `server/routes/chatPlan.ts` + `server/plan-execute/graph.ts`。
- [x] 2.5 实现 Planner，非法计划回退 ReAct（步骤 3 / 4）
  - Mock Planner + 真实 Planner，非法/空/超长计划统一回退 ReAct。
- [x] 2.6 实现顺序 Executor 和单步上下文收窄（步骤 5）
  - 单步只拿目标、当前步骤、已完成摘要和允许工具。
- [x] 2.7 接入现有工具、trace 和人工确认（步骤 7）
  - 复用 `toolGuard` / `ConfirmSession` / trace 出口。
- [x] 2.8 实现最多一次的受控 Re-plan（步骤 7）
  - `decideReplan` + `validateReplanCandidate`，硬上限 1 次。
- [x] 2.9 禁止确认拒绝被 Re-plan 绕过（步骤 7）
  - `confirm_denied` 直接终止，不进 Re-plan、无替代工具调用。
- [x] 2.10 前端展示计划、步骤状态和 Re-plan 新旧关系（步骤 9 / 10）
  - `useChat.ts` 计划状态机 + `PlanTimeline.vue`。
- [x] 2.11 补计划、失败、中止、确认拒绝 Evals（步骤 11）
  - `evals/dataset-plan.json` 22 条，离线判分 22/22 通过。
- [x] 2.12 文档对比 ReAct 与 Plan-and-Execute 成本和延迟（步骤 11）
  - `docs/plan-and-execute.md` 已写对比表结构；表内真实数字需 `eval:plan --compare`。

### 检查点 2

- [x] 简单任务不调用 Planner
  - 验收 1「你好」→ `mode=react`，`plannerCalled=false`。
- [x] 复杂任务可见计划与逐步骤执行
  - 验收 2「广州天气，顺便查查几点」在 `plan` 模式下计划可见、两步完成；
    `auto` 模式按规则走 ReAct（天气/时间是单步只读工具豁免项）。
  - 验收 3「先查资料，再写一份部署方案对比」→ `auto` 走 plan，三步全部完成。
- [x] Re-plan 最多一次
  - `plan-replan-once` / `plan-replan-limit` 两条剧本通过。
- [x] `npm run typecheck`
  - 通过（`vue-tsc --noEmit` + `tsc -p tsconfig.server.json --noEmit`）。
- [x] `npm run build`
  - 通过（1814 modules，产物 `dist/`）。
- [x] 相关 Evals 通过
  - plan-execute 单测 50/50、`chatPlan` 路由测试 4/4（合计 54/54）。
  - `npm run eval:plan` 离线判分 22/22。
- [ ] 真实模型回归（`npm run eval:chat` / `eval:multi` / `eval:plan --compare`）
  - 阻塞：需要联网调用 LLM，本机沙箱无外网；且未获批联网授权。
  - 待用户在本地执行：`npm run eval:chat && npm run eval:multi`。
- [ ] 浏览器人工点验（第 5、7 条）
  - 阻塞：沙箱不能监听端口，无法起服务 + 开浏览器。
  - 第 5 条（`draft_message` 拒绝后无替代工具）已由服务端图测试覆盖。
  - 第 7 条（刷新不污染长期历史）已由代码走查确认：计划状态只存在内存
    `planState`，`ChatMessage` 无计划字段，不写入 localStorage。

## 3. 长上下文管理

> 详细步骤、完成判定与失败路径见 `tasks/long-context-management-plan.md`。

执行单位是「指令」，一条指令 = 一个可交付的工作单元。

- [x] 指令 1 · 基线与预算定稿（A1～A3）
- [x] 指令 2 · 上下文核心纯函数（B1～B5）
- [x] 指令 3 · 摘要生成器（B6～B7）
- [x] 指令 4 · 服务端接入（B8、C1～C4）
- [x] 指令 5 · 前端接入（D1～D5）
- [ ] 指令 6 · 50 轮验收脚本（E1～E2）
- [ ] 指令 7 · 回归与数据（E3～E4）
- [ ] 指令 8 · 文档与清单收尾（E5～E6）

### 子任务明细

- [x] 3.1 记录目标模型上下文窗口和价格（`step1-chat/docs/long-context.md` 第 1 节）
- [x] 3.2 写 10 轮基线脚本，量化“8 条截断”丢了什么
      （`step1-chat/scripts/baseline-context.ts`）
- [x] 3.3 量 system prompt 的固定成本占比（估算 452.5 token，占饱和窗口 48.4%）
- [x] 3.4 定义上下文相关类型与版本常量（`server/context/types.ts`）
- [x] 3.5 实现 token 预算与保守估算器（`server/context/tokenBudget.ts`）
- [x] 3.6 实现分层上下文构建器（`server/context/buildContext.ts`）
- [x] 3.7 实现结构化摘要生成器（`server/context/summarize.ts`）
- [x] 3.8 保留 `clipMessages` 旧行为（仅加注释指向新构建器，语义未变）
- [x] 3.9 `server/chat.ts` 接上下文构建与摘要失败回退
- [x] 3.10 `server/routes/chat.ts` 收 `contextSummary`、推 `context_compacted`
- [x] 3.11 保证 tool call 与 tool result 成对（`server/context/assertToolPairing.ts`）
- [x] 3.12 前端类型与 `context_compacted` 解析（`src/types.ts`、`src/api/chat.ts`）
- [x] 3.13 前端持久化摘要并显示压缩提示（`src/composables/useChat.ts`、`ContextCompactionNotice.vue`）
- [ ] 3.14 增加 50+ 轮脚本，能引用第 3 轮事实
- [ ] 3.15 记录压缩前后 token、摘要成本和回答质量

### 检查点 3

- [ ] 50+ 轮测试通过
- [ ] 输入 token 不超预算
- [ ] 摘要失败不阻断聊天
- [ ] 旧历史正常加载

### 指令 1 实测结论（2026-11-05）

- 按 8 条截断时，第 1 轮写入的唯一事实**只撑住 5 轮**，第 6 轮起就不在请求里。
- system prompt 估算 **452.5 token**，占饱和窗口（940 token）的 **48.4%**——
  每轮输入预算近一半花在重复发送同一段系统提示上。
- 初始预算取 `65536 × 0.5 = 32768` tokens，实际链路的窗口用
  `LLM_CONTEXT_WINDOW_TOKENS` 覆盖（指令 4 落地）。
- 真实模型的 `promptTokens` **未运行**：本次为 Mock 运行，网关在当前环境不可达。

### 指令 2 结论（2026-11-05）

- 估算口径与基线脚本**逐样本一致**（CJK×1.0 + 非CJK÷4 + 每条 4 开销），
  安全系数 1.15，预算 = 窗口 × 0.5（64000 × 0.5 = 32000）。
- 输出顺序固定：**system → 摘要（独立 system 消息）→ 近期原文**。
- 修正了原计划的一处措辞：**最后一条未回应的 user 是「本轮提问」，必须保留**
  （必要时截断内容）；中间历史的孤儿 user 才是不单独保留、进摘要器的那一类。
- 摘要按 `compactedUntilIndex`（下标口径）去重，覆盖范围内的原文不再重复注入；
  版本不认识或摘要超预算 → 忽略摘要、`usedSummary=false`、`degraded=true`，不报错。
- 不变量 `estimatedTokens ≤ budgetTokens` 在 60 组随机组合下全部成立；
  单条超预算消息被截断并打「已截断」标记，不抛异常。
- 覆盖了 B5 的 7 种边界情况 + 孤儿 user + 摘要截断优先级，共 10 组检查全部通过
  （用临时脚本验证，跑完即删，未留下测试文件）。

### 指令 3 结论（2026-11-05）

- `server/context/summarize.ts` 完成：低温度 0.2 + JSON mode + Zod 校验，
  **所有失败路径统一收敛到 `null`，不抛异常**（决策四的落点）。
- 失败路径实测覆盖：code fence、缺 `facts` 字段、非法 JSON、非 200、网络异常、
  超时、裁剪后一条不剩 —— 全部返回 `null`，聊天链路不会因此中断。
- 重试策略：**只有 400 才重试**（参数不被兼容层接受才值得换形状），
  三次尝试依次去掉 `response_format` 与思考模式。
- 模型只负责「提炼四类内容 + 抄回来源下标」；**去重、合并旧摘要、长度裁剪全在服务端用代码做**，
  避免让模型重述旧内容导致失真。同 key 去重时保留来源更晚的那条。
- 长度上限 1200 字符，优先级 `userConstraints > facts > decisions > unresolved`；
  某一类整体装不下时裁短它的第一条，保证「用户约束至少保住一条」。
- 修正了一处健壮性问题：单条文本长度**不进 schema**（模型写超长是常态，
  让一条超长作废整份摘要太脆），改由代码裁剪。
- 覆盖范围用**下标口径**：`compactedUntilIndex = max(旧摘要覆盖位, 本次丢掉的最大下标)`。
  端到端不变量「被摘要覆盖的消息在下一轮不再重复注入」已验证成立。
- 验证：一次性脚本 37 项检查全部通过（跑完即删，未留下测试文件）；
  `npx tsc -p tsconfig.server.json --noEmit` 通过。
- **摘要质量本身未实测**：当前环境无法连通网关，提炼准不准、会不会漏关键约束
  留到指令 6 的 50 轮脚本里验证。

### 指令 4 结论（2026-11-05）

- **`contextMode` 默认 `legacy`**：`/api/chat` 路由显式传 `"budget"`；
  `/api/chat/plan` 的 ReAct 回退分支与评测脚本继续走 legacy，
  保证「不静默改变现有链路语义」。
- **`maxContextMessages` 语义随模式变**：legacy = 多少**条**消息；budget = 多少**轮**。
  已在代码注释里写明，避免后续误用。
- 摘要成功 → 用新摘要**重建**上下文（`compactedUntilIndex` 前进 → 旧消息不再重复注入）
  → `degraded=false`；摘要失败 → **不注入任何摘要** → `degraded=true`，聊天继续不中断。
- 压缩事件**只在真的丢掉内容时**发（`droppedMessages.length > 0`），未达阈值不发噪音；
  Mock 模式（`forceMock`）不触发摘要生成，summary 恒为 `null`。
- `context_compacted` 事件**不带 `delta` 字段** → 前端 `src/api/chat.ts` 只在
  `event.delta` 存在时调 `onDelta`，不会把压缩事件误渲染成回答文本。
- `ContextCompactionEvent` 从 `interface` 改成 `type`：接口没有隐式索引签名，
  会导致 `writeSse(event)` 的 `Record<string, unknown>` 报错。
- 非法摘要返回 200 且**等同无摘要**（zod 逐字段校验：结构性问题整份丢弃，
  条目问题只丢该条，旧版本号 → null），不会让请求直接报错。
- 工具配对断言覆盖 5 类问题：孤儿 tool_call、孤儿 tool 结果、顺序颠倒、
  id 重复声明、结果重复回填，全部抛错；在进图前与 `applyTools` 回填后各调一次。
- 验证：一次性脚本 **40 项检查全部通过**（跑完即删，未留下测试文件）；
  `npx tsc -p tsconfig.server.json --noEmit` 通过（No errors found）。
- **真实 token 与摘要质量仍未实测**：当前环境网关不可达，真实 `promptTokens`、
  压缩前后差值、摘要提炼准确度留到指令 6。

### 指令 5 结论（2026-11-05）

- 前端类型与服务端 `server/context/types.ts` **逐字段同名同义**：
  `ContextSummary` / `ContextSummaryItem` / `ContextFact` / `ContextCompactionEvent`。
- 摘要校验放在前端 `normalizeContextSummary()`，与服务端同一套原则：
  版本不认识 → 整份丢弃；单条内容不对 → 只丢那一条。**前端不信任外部数据**。
- `context_compacted` 事件**不带 `delta` 字段**，前端单独分支处理后 `continue`，
  既不会污染回答正文气泡，也不会被当成未知事件丢掉；未知事件仍然忽略。
- 摘要用**独立 localStorage key**（与聊天历史分开）：历史可清空，摘要是跨轮记忆。
  清空会话时摘要一并清掉——摘要按消息下标覆盖历史，历史清空后下标全部失效。
- 压缩提示只反映**最近一次请求**：每轮请求开始时重置，本轮没压缩就不显示旧提示，
  不制造噪音。
- 组件 `ContextCompactionNotice.vue`：一行结论 + 可展开四类条目（约束/事实/决定/未决），
  只显示条目文本不显示推理过程；`degraded: true` 时退化成「本轮未启用摘要」的纯提示。
  窄屏靠 `flex-wrap` + `overflow-wrap: anywhere` 保证不溢出。
- `UsagePanel` 增加「上下文压缩」行（压缩前 → 压缩后 token，附摘要自身 token），
  没有压缩时不显示这一行。
- **生效范围提示**：上下文压缩只发生在单 Agent 链路 `/api/chat`。
  多 Agent 链路只把当前这一轮交给图，不存在历史压缩；计划链路仍走 legacy。
- 验证：一次性脚本 15 项（SSE 解析）+ 10 项（持久化）全部通过，跑完即删；
  `npm run typecheck` 与 `npm run build` 均通过。
- **浏览器人工点验未做**：沙箱不能监听端口，起不了服务 + 开不了浏览器。
  组件的实际渲染效果留到指令 8 的收尾时人工确认。

## 4. Vision

- [ ] 4.1 确认目标模型支持图片并记录计费规则
- [ ] 4.2 定义 text/image content part 与附件类型
- [ ] 4.3 后端支持多模态消息且保持 tool_calls 协议不变
- [ ] 4.4 前端支持上传/粘贴、预览、移除
- [ ] 4.5 前后端双重校验 MIME、大小和 data URL
- [ ] 4.6 不支持图片的模型禁用 Vision 模式
- [ ] 4.7 完成“UI 截图 -> 问题 -> 修复建议”场景
- [ ] 4.8 记录图片 token 与成本
- [ ] 4.9 验证图片不进入服务端 usage 日志
- [ ] 4.10 测试文本链路、工具链路和旧历史兼容

### 检查点 4

- [ ] 粘贴截图可完成一次分析
- [ ] 格式/大小/模型不支持均有明确错误
- [ ] 清空会话后不残留 data URL
- [ ] `npm run typecheck`
- [ ] `npm run build`

## 5. Memory

- [ ] 5.1 定义匿名 user ID 与隐私边界
- [ ] 5.2 实现 `MemoryFact` 数据结构和独立存储
- [ ] 5.3 增加列表、新增、修改、删除、清空 API
- [ ] 5.4 实现明确偏好的结构化抽取
- [ ] 5.5 实现低置信度和敏感信息拒存
- [ ] 5.6 只注入相关前 5 条事实并标明短 ID
- [ ] 5.7 前端增加 Memory 管理面板与全局开关
- [ ] 5.8 测试跨会话命中、编辑、删除和关闭
- [ ] 5.9 再评估语义记忆是否值得引入
- [ ] 5.10 测试存储损坏、重复值和并发写回退

### 检查点 5

- [ ] 会话 A 保存，会话 B 能使用
- [ ] 删除或关闭后立即失效
- [ ] 敏感信息不自动保存
- [ ] `npm run typecheck`
- [ ] `npm run build`

## 6. LLM-as-Judge

- [ ] 6.1 建立注入/正常安全讨论/泄露输出的标注数据集
- [ ] 6.2 定义风险分类、置信度和短理由 schema
- [ ] 6.3 增加独立 Guard 模型配置
- [ ] 6.4 实现可 mock 的输入 Judge
- [ ] 6.5 先以 shadow 模式记录，不改变主回答
- [ ] 6.6 对比正则 vs Judge 的误报率、漏报率、延迟、成本
- [ ] 6.7 增加 `off/shadow/enforce` 配置
- [ ] 6.8 实现输出 Judge 与安全替换策略
- [ ] 6.9 测试超时、非法 JSON、模型被反向指令操控
- [ ] 6.10 输出模型版本可复现的评测报告

### 检查点 6

- [ ] shadow 不影响主链路
- [ ] enforce 有阈值和失败策略
- [ ] 指标可从记录中计算
- [ ] `npm run typecheck`
- [ ] `npm run build`

## 7. Reflection

- [ ] 7.1 定义相关性/完整性/依据/清晰度 rubric
- [ ] 7.2 定义结构化 `CritiqueSchema`
- [ ] 7.3 新增独立 `/api/chat/reflection`
- [ ] 7.4 实现 draft -> critic -> 最多一次 revise
- [ ] 7.5 第二次不优于第一次时停止
- [ ] 7.6 重写禁止引入工具事实之外的新内容
- [ ] 7.7 推送评分、重写、跳过 trace
- [ ] 7.8 对比原答案与 Reflection 的质量、延迟、成本
- [ ] 7.9 Evals 无收益时不并入默认链路
- [ ] 7.10 文档说明自评偏差

### 检查点 7

- [ ] 最多一次修订
- [ ] 无改进立即停止
- [ ] trace 可解释
- [ ] 有质量/成本对比
- [ ] `npm run typecheck`
- [ ] `npm run build`

## 8. Tool 动态发现

- [x] 8.1 盘点所有硬编码工具名
  - 2026-11-06：4 个工具名、7 个运行时消费方、5 个派生/展示位置、4 类数据级引用已盘点并记录。
- [x] 8.2 增加 `listToolNames()` 并让 Guard 读注册表
  - 2026-11-06：注册表新增 `listTools()` / `listToolNames()`；Guard 改为派生名单。
  - Guard 专项测试 4/4 通过；`npm run typecheck` 通过。
- [x] 8.3 定义 `ToolModule` 元数据
  - 2026-11-06：新增 tags / risk / includeInDefaultChat / mcp 契约，`ToolDefinition` 保持兼容。
- [x] 8.4 把现有工具迁入固定 modules 目录
  - 2026-11-06：4 个工具迁入模块目录，注册表静态 import；注册表专项 7/7 通过，`npm run typecheck` 通过。
- [x] 8.5 实现 `discoverTools()` 与启动校验
  - 2026-11-06：tools/discover.ts 固定目录扫描 + 启动校验（缺 run、重名、name/schema 不一致、非法 tag 均失败）；tools/registry.ts createRegistry 派生 findTool/listTools/listToolNames/toolsWithTags/toolsWithMcp/toolSchemasForChat；tools/index.ts 顶层 await discoverTools() + createRegistry()，非测试环境打印发现日志（仅模块名/tags/risk/MCP，无绝对路径）。
  - toolRegistry.test.ts 中 toolSchemas 身份断言已按字母顺序修正为 draft_message/getCurrentTime/getWeather/searchDocs。
  - 验证：node --import tsx-loader --test server/tools/toolRegistry.test.ts server/guard/toolCallGuard.test.ts 8/8 通过；npm run typecheck 通过。
  - 发现顺序：draft_message, getCurrentTime, getWeather, searchDocs（按目录名 localeCompare 字母顺序）。
  - 2026-11-06 补充：`npm run build`、`npm run mcp:ping` 已跑通（见 8.10）。
- [x] 8.6 Chat schema、findTool、MCP 都读发现结果
  - 2026-11-06：Chat 用 `toolSchemasForChat`，`findTool` 来自注册表 Map，MCP 改为 `for (const t of toolsWithMcp()) registerTool(...)`。
  - 补记（阶段 5 引入的回归，已修）：MCP 侧原本没有入参 schema，`run` 收到的是协议 extra 对象，表现为「缺少参数 city」。
    改为模块声明 `mcp.inputSchema`（zod shape），注册时对无参工具补空 shape，并新增 `server/mcp/createServer.test.ts` 锁死行为。
- [x] 8.7 Worker 用 tag/显式策略过滤
  - 2026-11-06：realtime / kb / action 三个 Worker 改用 `toolsWithTags([...])`，隔离边界保持显式。
- [x] 8.8 验证新增测试工具只加一个目录
  - 2026-11-06：`server/tools/discovery.test.ts` 在临时目录里只建一个 module 目录即可被发现。
  - 顺带修掉该文件本身的坏味道：原先所有子用例共用一个临时目录互相污染，且会往仓库里落 `temp_tools/`；现已改成每用例独立目录 + 系统临时目录。
- [x] 8.9 验证缺 run、重名、schema 不一致会启动失败
  - 2026-11-06：`discover.ts` 启动期校验覆盖缺 tool 导出 / 非法 risk / 工具重名，`name` 与 `schema.function.name` 不一致由 `assertConsistent` 拦截，均有反向测试。
- [x] 8.10 回归 MCP ping、单 Agent、多 Agent 和人工确认
  - 2026-11-06：MCP ping 通过——`toolsWithMcp()` 派生 3 个工具（`draft_message` 不暴露），`getCurrentTime` / `getWeather` 入参正常传达到 run。
    （沙箱内 `tsx` CLI 的 IPC 套接字被拦，改用等价命令 `node --import tsx` 起 stdio server 验证。）
  - 未实测：单 Agent / 多 Agent / 人工确认的端到端回归依赖真实模型调用，本轮环境模型服务返回「暂时不可用」，留待下次补。

### 检查点 8

- [x] 不再手抄 `ALLOWED_TOOLS`（Guard 读 `listToolNames()`，并有源码级断言守住）
- [x] 不再手工逐个注册 MCP 工具（`toolsWithMcp()` 循环注册）
- [x] Worker 仍保持隔离（`toolsWithTags` 显式策略）
- [x] `npm run typecheck`（2026-11-06 通过）
- [x] `npm run build`（2026-11-06 通过）
- [x] `npm run mcp:ping`（2026-11-06 通过，等价命令；含工具清单与入参回归）

## 9. 前端 Agent 框架对比

- [ ] 9.1 记录现有手写 SSE 基线和核心代码量
- [ ] 9.2 建立独立 `experiments/agent-sdk-compare`
- [ ] 9.3 完成 Vercel `useChat` 普通聊天 spike
- [ ] 9.4 完成 Vercel `useObject` 结构化输出 spike
- [ ] 9.5 完成 LangChain.js 浏览器端可行性 spike
- [ ] 9.6 用 5 个固定场景对比能力
- [ ] 9.7 测量首字、停止响应、构建体积和依赖
- [ ] 9.8 输出采用/不采用 ADR
- [ ] 9.9 确认实验依赖不进入主应用

### 检查点 9

- [ ] 同场景记录完整
- [ ] 有真实浏览器与构建数据
- [ ] ADR 有明确结论
- [ ] 主应用依赖未变化

## 10. AB 测试 / 在线 Evals

- [ ] 10.1 定义实验、变体、权重、版本和最小样本数
- [ ] 10.2 为请求生成统一 `requestId`
- [ ] 10.3 实现匿名 `clientId` 的稳定 hash 分流
- [ ] 10.4 抽出 prompt 版本注册表
- [ ] 10.5 SSE 返回 `requestId/experimentId/variant`
- [ ] 10.6 前端增加 thumbs up/down 和失败原因
- [ ] 10.7 新增反馈 API 与独立存储
- [ ] 10.8 汇总请求、成功、延迟、token、成本、工具和满意度
- [ ] 10.9 增加最小样本提示
- [ ] 10.10 串联 online result 与离线 Evals
- [ ] 10.11 测试稳定分流、重复反馈、脱敏和删除

### 检查点 10

- [ ] 同 `clientId` 分流稳定
- [ ] `requestId` 可关联 SSE/usage/trace/feedback
- [ ] 指标按 variant 查询
- [ ] 样本不足不宣布胜出
- [ ] `npm run typecheck`
- [ ] `npm run build`

## 主线未完成项

这些不属于进阶学习计划：

- [ ] 阶段 5 交付页：调试页、日志页、成本页和 Evals 交付
- [ ] RAG 上传文档完整应用
- [ ] Bug 分析作品集
- [ ] 需求转代码作品集
- [ ] 全部学习结束后的工程优化与逻辑清理

## 常用命令

在 `step1-chat/` 下执行：

```bash
npm run typecheck
npm run build
npm run eval:chat
npm run eval:multi
npm run eval:plan
```

真实 LLM Evals 需要 `LLM_API_KEY`，且不能设置 `MOCK_MODE=1`。

`npm run eval:plan` 是离线 Mock 判分，不需要网络；加 `--compare` 才会打真实模型。
 - [x] 指令 6 · 50 轮验收脚本（E1～E2）
 - [x] 指令 7 · 回归与数据（E3～E4）
 - [x] 指令 8 · 文档与清单收尾（E5～E6）
