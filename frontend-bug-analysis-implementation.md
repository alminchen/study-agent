# Bug 分析 Demo — 精简实现说明（当前主推）

> **状态：仅文档。** 说「按文档开始实现」后再改代码。  
> **原则：不新开架构；实现时 Copy `step1-chat` 现有逻辑再改薄层。**  
> 需求转代码仍后置：`frontend-dev-assistant-implementation.md`。

---

## 0. 实现约定（已拍板）

- **对**：流程以精简版为准（复用 chat、KB 可选、空库仍进 LLM）。  
- **做法**：到时 **Copy step1-chat** 的聊天 / prefetch / system / 前端发送链路，只加 Bug 模式差分；不另起炉灶。  
- 可复制落点示意：`server/chat.ts`、`prefetchSearchDocs`、`routes/chat.ts`、`useChat.ts`、`App.vue` 模式切换。

---

## 1. 定位（别做成新产品）

在现有聊天里加一个 **「Bug 分析」入口**：用户贴报错（±代码）→ 还是走现在的 `/api/chat`（可选勾选搜索知识库）→ 助手用**排障向 system** 回答。

要展示的是你已经会的能力（SSE、searchKb、Guard、Usage、过程面板），不是再发明一套 codegen / 新图 / 新协议。

---

## 2. 直接复用 vs 需要改的

| 已有（不动或几乎不动） | MVP 才需要的增量 |
|------------------------|------------------|
| `/api/chat` + ReAct | 一种 **bug 模式 system**（或模式开关改 `buildSystemPrompt`） |
| `searchKb` 勾选 + prefetch | **Bug 模式下：KB 空仍继续调 LLM**（见下；与资料问答/当前 chat 判空停不同） |
| ToolTrace / Usage / Guard | 输入区：报错 + 可选代码 → **拼成一条 user 发出去** |
| 前端 `useChat` / 气泡 | 2～3 条「一键填入」演示报错（可选） |
| Mock | 不必新 API |

**不做（本期）：**

- 新仓库 / 新 Express 应用  
- 新 `POST /api/bug/analyze`、新 LangGraph、强制 JSON schema UI  
- 双栏「专业排障工作台」、patch Tab、写盘、Evals 大套、Vision  

结构化 JSON 分区展示 → **以后有余力再加**；第一期 Markdown 回答即可。

---

## 3. 主流程（最终就这样）

```
用户填：报错（必填）+ 代码（可选）+ 是否勾选「搜索知识库」
        │
        ▼
拼成一条 user 消息（模板固定，见 §5）
        │
        ▼
POST /api/chat   ← 现有链路
        │
        ├─ 未勾选 KB ──► 直接 ReAct / 回答
        │
        └─ 勾选 KB
               ├─ 有命中 ──► system 注入资料 ──► 再 LLM
               └─ 无命中 ──► 标注未命中 ──► 仍 LLM（Bug 模式专用；不在此结束）
        │
        ▼
现有气泡里看分析（可含修复代码块）+ 现有 Usage / Trace
```

和「资料问答」的差别只说一句：**资料问答可以判空不调模型；Bug 分析勾了 KB 也必须落到 LLM。**

---

## 4. 实现要点（预计改动面很小）

### 4.1 前端

- 模式：`聊天 | 资料问答 | Bug 分析`（或 Bug 分析时隐藏无关 starter，显示两个 textarea）
- Bug 模式下点发送：不新开 API，调用现有 `send()`，content 用模板拼接
- `searchKb` 开关继续用；文案可改成「先查排错笔记（没有也继续分析）」

### 4.2 后端

- `chat.ts`：`bugMode`（或 `mode: "bug"`）时换一套短 system：前端排障、给根因、步骤、可复制代码；勿编造文件路径
- **仅 bugMode**：`prefetchSearchDocs` 判空时 **不要** `empty: true` 直接结束；改为注入「知识库未命中…」并继续 `runConversation`  
  （普通聊天 / 资料问答行为保持现状，避免回归）

### 4.3 不用新模块的东西

- Guard / Usage：请求仍进现有 chat → 自动带上  
- 不必先上 output 结构化解析  

---

## 5. 用户消息模板（前端拼接）

```
【报错】
{errorText}

【相关代码】
{codeSnippet 或 （未提供）}

【补充】
{extraContext 或 （无）}

请分析原因并给出可粘贴的修复建议。
```

---

## 6. 验收（够 Demo 即可）

1. Bug 模式下一键演示报错 → 有可读分析（含或可含代码块）  
2. 不勾 KB：只走 LLM，行为正常  
3. 勾 KB 有命中：回答能用到资料；Trace/命中可感知（沿用现有即可）  
4. 勾 KB 无命中：**仍有 LLM 分析**，不是固定「资料里没有」就结束  
5. 未把普通聊天的「KB 空则停」改坏  
6. typecheck 过  

---

## 7. 和旧版长文档的关系

此前一版写了独立 API、JSON schema、双栏工作台、分期 Phase 0–4，**过重，作废作主方案**。  
以**本文精简版**为准；长文思路仅作以后增强参考，不按那份开工。

---

## 8. 修订

| 日期 | 变更 |
|------|------|
| 2026-08-20 | 初稿（偏重） |
| 2026-08-20 | 收束：复用 `/api/chat`，只加模式 + KB 空继续 + 输入模板 |
| 2026-08-20 | 确认：实现时 Copy step1-chat 逻辑 |
