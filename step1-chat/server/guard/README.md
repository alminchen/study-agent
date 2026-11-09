# server/guard/ — Prompt Injection 基础防护

> 所属学习阶段：**阶段 5 · Prompt Injection 基础防护**
> 学习计划文档：`stage5-prompt-injection-learning-plan.md`

## 模块职责

在 Agent 的输入、工具调用、输出三个环节加入安全检测层，防止用户通过构造恶意输入操控模型行为。

## 文件说明

| 文件 | 步骤 | 职责 |
|------|------|------|
| `inputGuard.ts` | 3a | 输入层检测：正则匹配注入模式，返回风险等级（high/medium/none） |
| `toolCallGuard.ts` | 3c | 工具调用验证：白名单 + 参数长度 + JSON 合法性校验 |
| `outputGuard.ts` | 3d | 输出层检测：指纹比对检测 system prompt 泄露，命中则替换 |

## 集成位置

### 单 Agent（`/api/chat`）

- `inputGuard` → `server/chat.ts`（每次请求检测用户最后一条消息）
- `toolCallGuard` → `server/react/applyToolCalls.ts`（执行工具前校验）
- `outputGuard` → `server/react/runConversation.ts`（reply 节点输出前检测）

### 多 Agent（`/api/chat/multi`）

- `inputGuard` → `server/routes/chatMulti.ts`（取到 lastUser 后检测，SSE 推 `injection_detected`）
- `toolCallGuard` → `server/multi-agent/runToolSafely.ts`（Realtime / KB Worker 执行工具前）
- `outputGuard` → `server/multi-agent/aggregate.ts`（最终回复写出前，含单 Worker 透传）

## 设计原则

- **只标记不拦截**（inputGuard）：避免误杀正常讨论安全话题的用户
- **白名单优先**（toolCallGuard）：模型幻觉出的工具名直接拒绝
- **指纹阈值**（outputGuard）：命中 ≥2 个关键短语才判定泄露，减少误报

## 阶段 6 · LLM-as-Judge（语义判定层）

> 所属学习阶段：**阶段 6 · LLM-as-Judge**
> 学习计划文档：`tasks/llm-judge-plan.md`

### 新增文件

| 文件 | 职责 |
| --- | --- |
| `guard/judge.ts` | 判定核心：纯函数，输入输出两侧判定，模型调用以 `callModel` 注入，不自带 fetch |
| `guard/judgeSchema.ts` | 结构化 Schema：`JudgeResult`，成功路径 `status: ok` 与失败路径 `status: error + errorKind` 分离 |
| `guard/judgePolicy.ts` | 决策表：三档模式与输入/输出侧动作映射，纯函数，可单测 |
| `guard/judgeRuntime.ts` | 运行时接线：真实模型调用 + trace 事件写入（`judge_shadow` / `judge_enforced`） |
| `guard/judge.test.ts` | 管线单测：注入假模型，验证重试、超时、坏 JSON、schema 错误等失败路径 |

### 三类判定面

- **输入（`input`）**：判定用户消息是否含注入意图，高风险且置信度达标时可拦截（`block`），中风险只打标放行。
- **检索（`retrieval`）**：判定进入 prompt 的 RAG 检索片段，避免被材料内容误当成用户发言。
- **输出（`output`）**：判定模型回复是否泄露 system prompt 或含不安全内容；不自动拦截，只建议（`flag`）；真流式未缓冲时 `enforce` 降级为 `shadow`。

### 三档模式

| 模式 | 行为 | 用途 |
| --- | --- | --- |
| `off`（默认） | 不调用模型，不产生事件，链路零变化 | 安全起步，零延迟零成本 |
| `shadow` | 调用 Judge，只写 trace，主回答不变 | 离线对齐与精度观察 |
| `enforce` | 调用 Judge，按决策表决定放行/拦截，主回答可变 | 生产拦截，需先达准入阈值 |

当前默认 `off`，精度评测达标前保持 `shadow`。

### 结构化判定结果

`JudgeResult` 分两条路径：
- 成功：`status: "ok"`，带 `risk`（`none|medium|high`）、`confidence`（0~1）、`categories`、`shortReason`、`matchedRules`
- 失败：`status: "error"`，带 `errorKind: "timeout|bad_json|api_error|schema_error"`、`retries`、`raw`（已截断）

失败绝不填进 `risk` 字段，避免把“没结论”误记为低风险。

### 与原有 Guard 的协作

正则 Guard（`inputGuard`、`outputGuard`）做快速模式匹配，只标记不拦截；Judge 做语义确认，二者组成双层防线。决策表以正则结果为优先，两者不一致时只打标不拦截。

### 集成位置

- 单 Agent：`chat.ts`（每条用户消息，输入侧 `runInputJudge`）
- 多 Agent：`routes/chatMulti.ts`（取到 lastUser 后输入侧判定，SSE 推事件）
- RAG：`routes/ragChat.ts`（检索片段输入侧判定）、`rag/answer.ts`（SSE 流式时机约束）
- ReAct：`react/runConversation.ts`（输出侧 `runOutputJudge`，reply 节点输出前）

trace 事件：`judge_shadow`、`judge_enforced`，前端 `src/types.ts` 与 `ToolTracePanel.vue` 只展示，不参与判定。

### 相关命令

- `npm run eval:judge` —— 真实模型评测（需 `LLM_API_KEY` 非空且 `MOCK_MODE != "1"`，mock 只验证管线）
- `npm run judge:check` —— 数据集前置检查
- `node --import tsx --test guard/judge.test.ts` —— 管线单测

### 当前状态

精度评测尚未全部达标 enforce 准入阈值（dev precision 1.000 / recall 0.684 / error 15% / p95 6059ms），因此当前保持 `shadow`，默认 `off`。详见 `docs/llm-judge.md` 与 `docs/llm-judge-changelog.md`。
