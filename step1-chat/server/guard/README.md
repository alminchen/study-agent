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
