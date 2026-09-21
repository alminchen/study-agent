# server/routes — HTTP 路由拆分

`server/index.ts` 只负责 dotenv、json middleware、listen。  
具体 `app.get` / `app.post` 在本目录按端点拆文件，方便对照学习。

| 文件 | 路径 | 响应 |
|------|------|------|
| `usage.ts` | `GET/DELETE /api/usage` | JSON |
| `health.ts` | `GET /api/health` | JSON |
| `ragChat.ts` | `POST /api/rag/chat` | SSE（资料问答 + Token + 三道 Guard + Trace + LangSmith） |
| `chat.ts` | `POST /api/chat` | SSE（单 Agent + ConfirmSession） |
| `chatConfirm.ts` | `POST/GET /api/chat/confirm` | JSON（人工确认，单/多 Agent 共用） |
| `chatMulti.ts` | `POST /api/chat/multi` | SSE（多 Agent + ConfirmSession；**invoke 中途**可写 pending_confirm） |
| `sse.ts` | （工具）SSE 头、`writeUsageToStream` | — |
| `index.ts` | `registerRoutes(app)` 汇总挂载 | — |

共享配置：`server/runtimeConfig.ts`（`getRuntimeConfig`）。

人工确认：`chat.ts` / `chatMulti.ts` 各自 `new ConfirmSession()`，前端共用 `chatConfirm.ts`。  
多 Agent 流程图：`docs/multi-agent-human-confirm-flow.svg`。
