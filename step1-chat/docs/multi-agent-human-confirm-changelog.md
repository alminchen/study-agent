# 多 Agent · 人工确认 · 修改记录

> 清单：`../../stage5-multi-agent-human-confirm-learning-plan.md`  
> **状态：已接入（方案 A：action Worker）**  
> 日期：2026-08-21

## 流程图（先看这里）

- 泳道图：**[multi-agent-human-confirm-flow.svg](./multi-agent-human-confirm-flow.svg)**（IDE 直接打开预览，或浏览器打开 [flows-index.html](./flows-index.html)#multi-human-confirm）
- 单 Agent 对照：[human-confirm-flow.svg](./human-confirm-flow.svg)

---

## 一句话

多 Agent（`/api/chat/multi`）在 Worker 执行中途也能 `pending_confirm` → 等人点允许/拒绝；复用单 Agent 的 `ConfirmSession` + `POST /api/chat/confirm`。

---

## 新增文件

| 路径 | 做什么 |
|------|--------|
| `server/multi-agent/workers/actionWorker.ts` | 新 Worker：只挂 `draft_message`；mini ReAct；工具走 `runToolSafely`（含确认） |
| `docs/multi-agent-human-confirm-changelog.md` | 本修改记录 |
| `docs/multi-agent-human-confirm-flow.svg` | 多 Agent 人工确认泳道流程图 |

---

## 修改文件（服务端）

| 路径 | 改了什么 |
|------|----------|
| `server/routes/chatMulti.ts` | **增加** `new ConfirmSession()` + `finally dispose`；**增加** `writeSse` / `onTrace`，invoke **进行中**写 SSE；不再等整图结束才推 `supervisor_route` / `worker_done` |
| `server/multi-agent/graph.ts` | **增加** options：`confirmSession` / `onTrace` / `writeSse`；supervisor/workers 节点即时 `writeSse`；Worker 调用时下传 session + onTrace |
| `server/multi-agent/workers/types.ts` | **增加** `WorkerContext.confirmSession?`、`onTrace?` |
| `server/multi-agent/runToolSafely.ts` | **重写签名**：第三参 options（`toolCallId` + session + onTrace + signal）；**增加**需确认分支（对齐 `applyToolCalls`）：Guard → pending → wait → allow run / deny 回填；并打 `tool_call` / `tool_result` |
| `server/multi-agent/workers/realtimeWorker.ts` | **修改** `runToolSafely(...)` 传入 `toolCallId` / session / onTrace / signal |
| `server/multi-agent/workers/kbWorker.ts` | 同上透传 |
| `server/multi-agent/workers/index.ts` | **增加**注册 `action: runActionWorker` |
| `server/multi-agent/supervisor.ts` | **增加** Worker 名 `action`；system / route enum / 白名单过滤；起草类路由规则 |

未改（复用）：`confirmGate.ts`、`chatConfirm.ts`、`draftMessage` 工具、`toolCallGuard`（已有 `draft_message`）、`applyToolCalls.ts`。

---

## 修改文件（前端）

| 路径 | 改了什么 |
|------|----------|
| `src/api/chat.ts` | **修改** `streamChat`：用独立参数 `multiAgent` 选 `/api/chat/multi` vs `/api/chat`；`searchDocs` 只进 body |
| `src/composables/useChat.ts` | **增加** `multiAgent` / `setMultiAgent`（localStorage）；与 `searchKb` 解耦 |
| `src/App.vue` | **增加**「多 Agent」勾选；title 随开关显示对应 endpoint |

`ToolTracePanel` / `App.vue` / `types.ts`：**未改**（已有 pending 按钮与类型，事件形状与单 Agent 一致）。

---

## 行为变化（相对改前）

| 场景 | 改前 | 改后 |
|------|------|------|
| multi 调 `draft_message` | 若能调到会立刻 run（实际未挂该工具） | 路由到 `action` → 面板待确认 → 允许才模拟发送 |
| multi SSE | 整图结束后才推 route/done | invoke 中途即可推 route / pending / worker_done |
| 普通聊天 | 前端打 `/api/chat` | 由独立开关 `multiAgent` 选接口（默认 multi） |
| 「搜索知识库」 | 单 Agent prefetch | 仍只传 `searchDocs`；**不**切换接口 |
| 「多 Agent」 | （无） | 勾选 → `/api/chat/multi`；取消 → `/api/chat` |

---

## 手测清单

| 状态 | 场景 | 期望 |
|------|------|------|
| [ ] | 未勾选 KB：`北京今天天气` | 无确认；正常答 |
| [ ] | 未勾选 KB：`起草一条消息：今晚开会改到 8 点，发给小王` | 出现待确认；未点前无「已发送」 |
| [ ] | 点允许 | 模拟发送；最终回复据此说明 |
| [ ] | 点拒绝 | 不执行；回答不假装已发送 |
| [ ] | 勾选「多 Agent」/ 取消 | 分别打 multi / 单 Agent；与「搜索知识库」互不影响 |
| [ ] | 勾选/不勾选 KB | 不改变 endpoint |

---

## 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-21 | 清单壳 |
| 2026-08-21 | 方案 A 落地：action Worker + multi 中途 SSE + 前端默认 multi |
| 2026-08-21 | 补流程图 `multi-agent-human-confirm-flow.svg`；独立「多 Agent」开关选路 |
