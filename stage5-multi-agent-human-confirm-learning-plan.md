# 多 Agent 接入人工确认 · 文件改动清单

> 已落地。详细「改了什么」见 `step1-chat/docs/multi-agent-human-confirm-changelog.md`。

## 必须改（已完成）

| 文件 | 改什么 |
|------|--------|
| `server/routes/chatMulti.ts` | ConfirmSession + 中途 SSE |
| `server/multi-agent/graph.ts` | 下传 session/onTrace/writeSse |
| `server/multi-agent/workers/types.ts` | Context 扩展 |
| `server/multi-agent/runToolSafely.ts` | 确认闸门 |
| `server/multi-agent/workers/realtimeWorker.ts` | 透传 |
| `server/multi-agent/workers/kbWorker.ts` | 透传 |
| `server/multi-agent/workers/actionWorker.ts` | **新建**，挂 draft_message |
| `server/multi-agent/workers/index.ts` | 注册 action |
| `server/multi-agent/supervisor.ts` | 路由含 action |
| `src/api/chat.ts` | 普通对话固定 multi；searchDocs 与 endpoint 解耦 |
| `src/composables/useChat.ts` | 注释对齐 |

## 不改（复用）

`confirmGate.ts` · `chatConfirm.ts` · `draftMessage` · `applyToolCalls.ts` · RAG/MCP
