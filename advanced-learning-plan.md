# 进阶学习计划（主线完成后深入）

> 基于主线学习计划的能力缺口分析，按优先级排列。挑选感兴趣的方向深入即可，不必全做。

## 当前进度

- [x] 第 1 项 Streaming 结构化输出：实现与文档已完成（2026-11-04）。
- [x] 第 2 项 长上下文管理：实现 Sliding Window + Structured Summary 混合策略，
  代码与文档已完成；50 轮验收脚本已补齐但本轮未运行（2026-11-05）。
- [x] 第 7 项 Plan-and-Execute：实现与文档已完成（2026-11-05）。
- [ ] 第 3-6、8-10 项：尚未开始，等待后续指令。

> 上述“完成”表示代码实现和文档沉淀完成。浏览器人工验收、真实模型回归、
> 真实 Token 统计与摘要质量评估仍需在具备模型和浏览器条件时补充。

---

## 较重要（推荐优先挑选 1-2 个）

### 1. Streaming 结构化输出

**现状**：已有 SSE 流式纯文本输出。
**缺口**：不支持边流边解析结构化数据（JSON、表格、代码块）。

**学习目标**：
- [x] 理解 OpenAI `response_format: { type: "json_object" }` 和流式 JSON 的兼容性
- [x] 实现流式 partial JSON 解析（边接收边渲染表格/代码）
- [x] 前端增量渲染结构化内容（如实时表格填充、代码高亮逐行出现）
- [x] 对比方案：Vercel AI SDK 的 `useObject` vs 手写 parser

**交付物**：聊天中请求“生成一个表格”时，前端能逐行渲染表格而非等全部完成。

**完成记录**：独立结构化 SSE 端点、partial parser、前端增量状态、学习总结和
全链路图已完成；详见 `step1-chat/docs/structured-output.md` 和
`step1-chat/docs/structured-output-flow.svg`。运行实测边界见本节进度说明。

---

### 2. 长上下文管理

**现状**：有 `clipMessages` 按条数截断。
**缺口**：没有智能压缩策略，长对话后会丢失早期重要信息。

**学习目标**：
- [x] 理解 token 窗口与对话质量的关系
- [x] 实现 Summarize-and-Compress：超过阈值时用 LLM 总结早期对话
- [x] 实现 Sliding Window + Summary 混合策略（最近 N 轮原文 + 更早的摘要）
- [ ] 对比：Map-Reduce 摘要 vs 递归摘要 vs 关键信息提取
- [x] 前端展示"已压缩 X 轮对话"的提示

**交付物**：50+ 轮对话后仍能准确引用第 3 轮提到的信息。

**完成记录**：实现了 Token 预算估算、结构化摘要、分层上下文构建和前端压缩提示；
50 轮验收脚本位于 `step1-chat/scripts/test-long-context.ts`，但尚未运行。
详见 `step1-chat/docs/long-context.md`。完成状态不代表 50 轮事实保留、
真实 Token 节省或摘要质量已经验证。

---

### 3. 多模态（Vision）

**现状**：纯文本输入输出。
**缺口**：不支持图片输入。

**学习目标**：
- [ ] 理解 Vision API 的 message 格式（`image_url` content part）
- [ ] 前端实现图片上传/粘贴 → base64 / URL 传递
- [ ] 后端适配多模态 message 结构
- [ ] 实践场景：截图 → Bug 分析 / UI 描述 → 代码生成
- [ ] Token 消耗对比（图片 token 计算规则）

**交付物**：粘贴一张 UI 截图，Agent 能描述界面内容或指出布局问题。

---

### 4. Memory（跨会话持久记忆）

**现状**：localStorage 存完整对话历史，每次新会话从零开始。
**缺口**：Agent 不记得用户偏好、过往结论。

**学习目标**：
- [ ] 理解 Memory 的两种形态：事实记忆（结构化 KV）vs 语义记忆（向量化）
- [ ] 实现基础事实记忆：Agent 主动提取 & 存储用户偏好（如"用户偏好深色模式"）
- [ ] 实现语义记忆：重要对话片段向量化，新对话时检索相关记忆注入 context
- [ ] Memory 的 CRUD：用户可查看、编辑、删除已存储的记忆
- [ ] 隐私考量：哪些信息应该记、哪些不该记

**交付物**：跨会话场景下，Agent 能记住"上次你问过 X，结论是 Y"。

---

### 5. Guardrails 进阶（LLM-as-Judge）

**现状**：正则规则检测 prompt injection。
**缺口**：无法检测语义层面的注入（改写、间接攻击）。

**学习目标**：
- [ ] 理解 LLM-as-Judge 模式：用一个小模型判定输入是否有害
- [ ] 实现双模型架构：Guard Model（轻量/快速）+ Main Model
- [ ] 结构化输出约束：`response_format` 强制模型输出符合 schema
- [ ] Output Guardrails：用 Judge 检测回复是否合规（比指纹检测更鲁棒）
- [ ] 成本 vs 安全的权衡：何时用规则、何时用 LLM 判定

**交付物**：对比正则 guard vs LLM guard 的误报率和漏报率。

---

## 次要（锦上添花）

### 6. Agent 自我反思（Reflection）

**学习目标**：
- [ ] 理解 Reflection 模式：Agent 生成 → 自评 → 不满意则重试
- [ ] 实现 Critic 节点：在 reply 前加一步自我评分
- [ ] 设定重试上限和质量阈值
- [ ] 与 Evals 的关系：离线评估 vs 在线自评

**交付物**：Agent 回答模糊问题时能自动检查并改进回复质量。

---

### 7. Plan-and-Execute 模式

**学习目标**：
- [x] 理解 Plan-and-Execute vs ReAct 的区别（先规划 vs 边走边看）
- [x] 实现 Planner 节点：给定任务 → 输出步骤列表
- [x] 实现 Executor 节点：逐步执行计划
- [x] 实现 Re-plan：执行中发现问题 → 修正计划
- [x] 适用场景判断：什么时候用 ReAct，什么时候用 Plan-and-Execute

**交付物**：复杂多步任务（如"帮我调研 X 并写一份报告"）能先列计划再执行。

**完成记录**：规则分类、Planner、顺序 Executor、最多一次受控 Re-plan、
人工确认拒绝边界和前端计划时间线已实现。详见
`step1-chat/docs/plan-and-execute.md` 和 `step1-chat/docs/plan-and-execute-flow.svg`。
服务端与离线 Mock Evals 已有通过记录；真实模型对比、浏览器人工验收和完整旧链路回归
仍需补做，因此完成状态不表示这些运行验收已经通过。

---

### 8. Tool 动态发现

**学习目标**：
- [ ] 理解静态工具注册 vs 动态发现的区别
- [ ] 实现工具注册中心（类似 MCP 客户端侧的发现机制）
- [ ] 运行时根据上下文动态加载可用工具
- [ ] 工具过多时的筛选策略（与当前问题相关的 Top-K 工具）

**交付物**：新增工具只需注册，无需改 Agent 代码。

---

### 9. 前端 Agent 框架对比

**学习目标**：
- [ ] Vercel AI SDK：`useChat`、`useObject`、`streamText`、tool calling
- [ ] LangChain.js 浏览器端：与后端 LangGraph 的配合
- [ ] 手写 vs 框架的 trade-off
- [ ] 各框架的 streaming、error handling、retry 策略对比

**交付物**：同一个聊天功能分别用 Vercel AI SDK 和手写实现，对比代码量和灵活性。

---

### 10. AB 测试 / 在线 Evals

**学习目标**：
- [ ] 理解离线 Evals vs 在线 Evals 的区别
- [ ] 实现简单的 AB 分流：同一问题用不同 prompt/模型回答
- [ ] 用户反馈收集（thumbs up/down）
- [ ] 指标看板：响应时间、用户满意度、工具调用成功率
- [ ] 与 Tracing 的结合：从 trace 数据中提取在线指标

**交付物**：对比两版 system prompt 的用户满意度差异。

---

## 学习建议

1. **主线先完成**：部署 → Token 计费 → 人工确认 → 工程优化
2. **再挑 1-2 个进阶方向**：推荐从"Streaming 结构化输出"或"长上下文管理"开始（与现有项目衔接最紧密）
3. **作品集导向**：如果目标是"前端开发助手"，优先做 Vision（截图分析）+ Plan-and-Execute（多步代码生成）
