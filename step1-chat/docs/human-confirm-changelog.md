# 人工确认 · 修改记录（维护用）

> 对应说明：`stage4-human-confirm-overview.md`  
> **流程图**：[human-confirm-flow.svg](./human-confirm-flow.svg) · [flows-index.md](./flows-index.md)  
> **阶段 A**：确认基建（已完成）  
> **阶段 B**：对接 `/api/chat` + 前端确认 UI（已完成）

---

## 1. 新建文件

| 状态 | 路径 | 作用 | 实际备注 |
|------|------|------|----------|
| done | `server/tools/schemas/draftMessage.ts` | schema | A |
| done | `server/tools/methods/draftMessage.ts` | 假执行 | A |
| done | `server/tools/modules/draft_message/index.ts` | 模块元数据（`risk: "confirm"`）+ schema + 假执行（阶段 5 目录化） | 阶段 5 |
| 已删除 | `server/react/toolsRequiringConfirm.ts` | 需确认名单（阶段 5 起改由注册表 `risk === "confirm"` 判定，文件已删除） | A → 阶段 5 |
| done | `server/react/confirmGate.ts` | ConfirmSession | A |
| done | `server/routes/chatConfirm.ts` | confirm API | A |

---

## 2. 修改文件（服务端）

| 状态 | 路径 | 内容 | 备注 |
|------|------|------|------|
| done | `server/tools/index.ts` | 注册；`includeConfirmTools` 时暴露 draft_message | B |
| done | `server/guard/toolCallGuard.ts` | 白名单 | A |
| done | `server/react/applyToolCalls.ts` | 确认分支 | A |
| done | `server/react/types.ts` | pending 事件 + confirmSession | A |
| done | `server/react/runConversation.ts` | 传入 session/signal | A |
| done | `server/react/complete.ts` | 有 session 时 tools 含 draft_message | B |
| done | `server/chat.ts` | system 起草规则；透传 confirmSession | B |
| done | `server/routes/chat.ts` | 创建/dispose ConfirmSession | B |
| done | `server/routes/index.ts` | 挂载 confirm | A |

---

## 3. 修改文件（前端）— 阶段 B

| 状态 | 路径 | 内容 | 备注 |
|------|------|------|------|
| done | `src/api/chat.ts` | 改回 `/api/chat`；pending/confirm 事件；`confirmChatTool` | |
| done | `src/composables/useChat.ts` | `resolveToolConfirm`；处理 confirm_resolved | |
| done | `src/types.ts` | Trace 类型扩展 | |
| done | `src/components/ToolTracePanel.vue` | 允许/拒绝按钮 | |
| done | `src/App.vue` | 绑定 confirm | |

---

## 4. 本课明确不改

| 路径 | 原因 |
|------|------|
| `server/multi-agent/**`、`chatMulti.ts` | ~~多 Agent 未接确认~~ → **已接入**，见 `multi-agent-human-confirm-changelog.md` |
| `server/rag/**`、`server/mcp/**` | 非本课 |

---

## 5. 行为回归清单

| 状态 | 场景 | 期望 |
|------|------|------|
| [ ] | `北京今天天气` | 无确认弹层 |
| [ ] | `现在几点` | 无确认 |
| [ ] | `起草一条消息：今晚开会改到 8 点，发给小王` | 过程面板出现待确认 + 按钮 |
| [ ] | 点允许 | 模拟发送；助手据此回答 |
| [ ] | 点拒绝 | 不执行；回答不假装已发送 |
| [ ] | 勾选搜索知识库普通问句 | 不误弹确认 |

---

## 6. 关键点速查

```
routes/chat.ts             ← ConfirmSession 创建/dispose
complete.ts                ← includeConfirmTools
applyToolCalls.ts          ← wait / deny 不 run
src/api/chat.ts            ← 必须是 /api/chat 不是 multi
ToolTracePanel + useChat   ← resolveToolConfirm
```

---

## 7. 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-21 | 阶段 A 落地 |
| 2026-08-21 | 阶段 A 补注释 |
| 2026-08-21 | **阶段 B 落地**：聊天创建 session、暴露 draft_message、前端确认 UI |
| 2026-11-06 | **阶段 5 动态发现同步**：`toolsRequiringConfirm.ts` 删除；需确认判定、Guard 白名单、MCP 注册全部改由 `server/tools/registry.ts` 派生 |
