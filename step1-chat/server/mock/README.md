# server/mock/ — 假流式回复

## 模块职责

没有 `LLM_API_KEY`，或者显式 `MOCK_MODE=1` 时，用本地拼的假回复把
**完整的 SSE 链路**跑通：前端能收到 delta、能渲染气泡、能关流，
但不会产生任何真实模型调用和 token 消耗。

## 文件说明

| 文件 | 职责 |
| --- | --- |
| `streamMock.ts` | `streamMock()`：按 4 字一段切片 + sleep，模拟打字效果 |

## 行为

- 取 messages 里最后一条 user 文本，回一句固定模板
- 每 4 个字符推一次 `onDelta`，配合 sleep 模拟流式
- 支持 `AbortSignal`：前端中断时抛 `AbortError`，与真实请求语义一致
- 不调模型、不调工具、不写 usage

## Mock 覆盖了哪些端点

| 端点 | 是否支持 Mock |
| --- | --- |
| `POST /api/chat` | 支持 |
| `POST /api/chat/plan` | 支持（只复述真实执行过的模拟步骤） |
| `POST /api/chat/structured` | 支持（模拟 partial JSON 和稳定快照） |
| `POST /api/chat/multi` | **不支持**，需要真实 Key |
| `POST /api/rag/chat` | **不支持**，需要真实 Key |

多 Agent 和 RAG 没有 Mock 分支，因为它们的编排本身就是被测的东西——
Mock 掉等于什么都没测。

## 相关文档

- `README.md`：Mock 模式与端点清单
- `server/chat.ts`：Mock 分支的调用点
