# server/routes/ — HTTP 路由拆分

`server/index.ts` 只负责 dotenv、json middleware、listen。
具体 `app.get` / `app.post` 在本目录按端点拆文件，方便对照学习。

## 端点总表

| 文件 | 端点 | 响应 |
| --- | --- | --- |
| `health.ts` | `GET /api/health` | JSON |
| `models.ts` | `GET /api/models` | JSON（代理 `LLM_BASE_URL/models`，失败回退内置列表） |
| `usage.ts` | `GET` / `DELETE /api/usage` | JSON |
| `chat.ts` | `POST /api/chat` | SSE（单 Agent + ConfirmSession） |
| `chatMulti.ts` | `POST /api/chat/multi` | SSE（多 Agent + ConfirmSession；**invoke 中途**可写 pending_confirm） |
| `chatPlan.ts` | `POST /api/chat/plan` | SSE（Plan-and-Execute） |
| `chatStructured.ts` | `POST /api/chat/structured` | SSE（Streaming 结构化输出：稳定快照 + 最终 schema 校验） |
| `chatReflection.ts` | `POST /api/chat/reflection` | SSE（独立反思端点） |
| `ragChat.ts` | `POST /api/rag/chat` | SSE（资料问答 + Token + 三道 Guard + Trace + LangSmith） |
| `chatConfirm.ts` | `POST /api/chat/confirm`、`GET /api/chat/confirm/:confirmId` | JSON（人工确认，单 / 多 Agent 共用） |
| `memory.ts` | `GET` / `POST` / `PATCH` / `DELETE /api/memory` | JSON（跨会话记忆的用户侧管理） |
| `sse.ts` | （工具）SSE 头、`writeUsageToStream` | — |
| `index.ts` | `registerRoutes(app)` 汇总挂载 | — |

## 两种响应风格

- **SSE**：聊天类端点。`sse.ts` 统一写 SSE 头和 usage 收尾，事件类型见主 README 的「SSE 事件」一节。
- **JSON**：查询和管理类端点。健康检查、模型目录、用量、记忆、人工确认。

## 三条链路的路由差异

| | `chat.ts` | `chatMulti.ts` | `chatPlan.ts` |
| --- | --- | --- | --- |
| 编排 | 单 Agent ReAct | Supervisor → Worker → Aggregate | Planner → Executor → Re-plan |
| ConfirmSession | 自己 new | 自己 new，**invoke 中途**也能写 pending_confirm | 不需要 |
| Mock | 支持 | 不支持 | 支持 |

**为什么多 Agent 的 pending_confirm 能写在 invoke 中途**：
Worker 调工具时也要人确认，如果只在整个 invoke 结束后才发事件，
用户要等全部 Worker 跑完才看到确认弹窗。

## 人工确认

`chat.ts` / `chatMulti.ts` 各自 `new ConfirmSession()`，
前端共用 `chatConfirm.ts`。闸门实现见 `server/react/confirmGate.ts`。

多 Agent 流程图：`docs/multi-agent-human-confirm-flow.svg`。

## 记忆接口的取舍

`memory.ts` 的四条端点全部要求 `userId`——服务端不采集真实身份，
匿名 id 由前端生成、只存在 localStorage，但仍要靠它做归属校验，
否则任何人都能读写别人的记忆。

不可改字段（key / source）传了直接返回 400 而不是静默忽略；
清空必须带 `confirm=all`。

## 共享配置

所有环境变量只在 `server/runtimeConfig.ts` 的 `getRuntimeConfig()` 里落地一次，
路由层不直接读 `process.env`。

## 相关文档

- `README.md`：HTTP API 与 SSE 事件完整说明
- `server/structured/README.md`：结构化输出的协议与状态机
- `server/memory/README.md`：记忆的数据模型与链路
