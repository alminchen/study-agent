# step1-chat 失败地图与恢复策略

> 记录 `/api/chat` 与 `/api/rag/chat` 在各层失败时：**用户看到什么、能否重试、ReAct 是否继续**。  
> 基于现网代码梳理（2026-08），供排错与后续改兜底策略时对照。  
> 泳道图：[resilience-failure-flow.svg](./resilience-failure-flow.svg) · [flows-index.md](./flows-index.md)

---

## 1. 填表用的四列

每行固定四个问题：

| 列 | 含义 |
|----|------|
| **失败类型** | 客观发生了什么（开发者语言） |
| **用户提示（现网）** | 聊天页上用户最终看到什么 |
| **是否可重试** | 用户点「重试 / 再发一条」有没有意义 |
| **是否允许模型继续** | 出错后 ReAct / 流程还要不要再问 LLM |

说明：

- **允许模型继续** ≠ 一定要继续。工具返回 `{ error }` 时，常表示「让模型看失败原因再组织回答」。
- **可重试** 指用户操作；与 `toolFailure` 连续失败停手不是同一回事。
- **新的一条用户消息** 会重新 `invoke`，工具连续失败计数会重置。

---

## 2. 请求链路

### 2.1 普通聊天 `/api/chat`

```
用户发消息
  → prefetchSearchDocs?（勾选「搜索知识库」）
  → askModel（第 1 轮）
  → applyTools?（getWeather / getCurrentTime / searchDocs）
  → askModel（第 2 轮 …）
  → reply（文字 → SSE delta）
```

相关代码：`server/chat.ts` → `server/react/runConversation.ts` → `server/react/prefetchSearchDocs.ts`

### 2.2 资料问答 `/api/rag/chat`

```
用户问句 + 历史
  → retrieveForAnswer（embed → 向量 TopK → 判空 → rerank?）
  → buildRagPrompt
  → 判空? → 固定文案，不调 LLM
  → 有资料 → completeRagMessages（一次 LLM，无 tools）
  → JSON 返回前端
```

相关代码：`server/rag/answer.ts` → `server/rag/prompt.ts` → `server/rag/complete.ts`

---

## 3. LLM 层（`/api/chat`）

| ID | 失败类型 | 用户提示（现网） | 可重试 | 模型继续 |
|----|----------|------------------|--------|----------|
| L1 | LLM HTTP 400 / 5xx（如 thinking 缺 `reasoning_content`） | 页面 `error`：`LLM 请求失败 (400): …`；气泡可能为空 | 偶发超时：可；400 协议类：重试通常无效，需先修回填 | **否**，整次 ReAct 中断 |
| L2 | LLM 超时 / 网络不可达 | SSE `error` 或「网络请求失败」 | **是** | **否** |
| L3 | 达到 `MAX_MODEL_TURNS = 5` 仍有 tool_calls | 气泡：`这轮没做完：已达到询问次数上限。` | **是**（换问法或再试） | **否**，系统主动停 |
| L4 | 无 API Key / `MOCK_MODE=1` | 假流式；health 为 `mock` | 配 Key 后**是** | N/A（未进真 LLM，属**降级**） |
| L5 | 模型不出 `tool_calls` 但该调工具（行为失败） | 可能凭记忆答；**无明确失败提示** | **是**，不保证变好 | 已结束（直接 reply） |
| L6 | 用户点击「停止」 | `已停止生成。` | **是** | **否** |

代码锚点：`server/react/complete.ts`、`server/react/runConversation.ts`、`server/chat.ts`（Mock）

---

## 4. 工具层（`/api/chat`）

约定：工具**不 throw**，统一 `{ error: "..." }` 回填（`server/react/applyToolCalls.ts`）。

| ID | 失败类型 | 用户提示（现网） | 可重试 | 模型继续 |
|----|----------|------------------|--------|----------|
| T1 | 工具参数非法（JSON / 缺 city / 缺 question） | 无单独错误条；ToolTrace 里 `tool_result` 带 error；最终靠模型解释 | 同一句重试意义不大 | **是** |
| T2 | 业务拒绝：非地球城市天气（如火星） | 模型应说明查不了；Trace 可见 error | **否** | **是** |
| T3 | 未知工具名 | `{ error: 未知工具: xxx }` 回填 | 一般**否** | **是** |
| T4 | 同一工具连续失败 ≥ 2 次（`toolFailure`） | 回填 `已停止再执行`；模型据此说明 | **是**（新消息重置计数） | **是**，但该工具本轮不再执行 |

代码锚点：`server/react/toolFailure.ts`、`server/tools/methods/*.ts`

---

## 5. 检索层（勾选知识库 / `searchDocs`）

| ID | 失败类型 | 用户提示（现网） | 可重试 | 模型继续 |
|----|----------|------------------|--------|----------|
| R1 | 向量库为空（未 `rag:ingest`） | system 注入 `【本轮知识库检索】未找到可用资料：…`（含 ingest 提示或「检索失败」） | ingest 后**是** | **是**（有瞎编风险） |
| R2 | 有召回但判空（分数低） | system 注入「未找到可用资料：资料里没有相关内容」 | 换问法**是**；同句通常**否** | **是** |
| R3 | reranker 未下载 | **无用户提示**；退回向量 TopK，console warn | 下载模型后**是** | **是**（**静默降级**） |

prefetch 路径：`server/react/prefetchSearchDocs.ts` → `executeSearchDocs` → `retrieveForAnswer`

---

## 6. 资料问答 `/api/rag/chat`

| ID | 失败类型 | 用户提示（现网） | 可重试 | 模型继续 |
|----|----------|------------------|--------|----------|
| G1 | `question` 为空 | 400；气泡「资料问答失败。」 | **否** | **否** |
| G2 | 检索判空 | 固定文案「资料里没有相关内容」；`calledModel: false`；hits 面板仍可看 | 换问法**是** | **否**（**不调 LLM**） |
| G3 | 向量库为空 | 500；error 可能含 `请先运行 npm run rag:ingest` | ingest 后**是** | **否** |
| G4 | reranker 未下载 | 无提示；质量可能变差 | 下载后**是** | **是**（静默降级） |
| G5 | RAG 调 LLM 失败 / 无 Key / Mock | 500 或 Key 提示；「资料问答失败。」 | 视 error | **否**（无 ReAct 第二轮） |
| G6 | 用户停止 | 「已停止生成。」 / 499 已取消 | **是** | **否** |

代码锚点：`server/rag/answer.ts`、`server/index.ts`（`/api/rag/chat`）

---

## 7. 前端层（两种模式）

| ID | 失败类型 | 用户提示（现网） | 可重试 | 模型继续 |
|----|----------|------------------|--------|----------|
| F1 | fetch 网络失败 | 顶部 `error`；聊天可能无气泡 | **是**（`retry`） | **否** |
| F2 | HTTP 非 200 | `服务异常：${status}`；RAG「资料问答失败。」 | 5xx：**是**；400：看原因 | **否** |
| F3 | SSE 流内 `{ error }`（聊天） | `onError` 显示服务端 error 原文 | 视内容 | **否** |
| F4 | 用户点「重试」 | 去掉上一条 assistant，同一 user 再问 | N/A | 全新一轮请求 |
| F5 | 工具失败仅 Trace、无独立错误条 | 用户只看模型怎么说；面板给开发者 | **是**，用户未必知是工具问题 | **是**（后端已继续） |

代码锚点：`src/api/chat.ts`、`src/api/rag.ts`、`src/composables/useChat.ts`

---

## 8. 两条路对比

| 场景 | `/api/chat` + 勾选知识库 | `/api/rag/chat` |
|------|-------------------------|-----------------|
| 检索判空 | 结果写进 **本轮 system**，**仍调 LLM** | **不调 LLM**，固定文案 |
| 工具失败 | `{ error }` 回填，ReAct 继续 | 无工具 |
| LLM 硬失败 | SSE `{ error }` | JSON 500 |
| 区分「没资料」vs「系统坏了」 | **弱** | **相对强** |

---

## 9. 现网已有兜底（不必从零发明）

| 机制 | 作用 |
|------|------|
| 工具 `{ error }` 不 throw | 工具软失败，ReAct 继续 |
| `toolFailure` 连续 2 次停手 | 防同一工具死循环 |
| `MAX_MODEL_TURNS = 5` | 防模型反复要工具 |
| `rerankerReady()`  false → 向量 TopK | 无 rerank 仍可用 |
| `streamMock` | 无 Key 仍可演示 |
| RAG `buildRagPrompt` 判空 | 空结果不调 LLM |
| 前端 `retry` / `stop` | 用户级恢复 |

---

## 10. 改进优先级（记录用，非本文件交付范围）

| 优先级 | 失败类型 | 现网问题 | 改进方向（后续改代码时参考） |
|--------|----------|----------|------------------------------|
| **P0** | 聊天 LLM 400（thinking） | 整句挂，error 偏技术 | 修协议回填 + 用户可见「请求失败，请重试」 |
| **P0** | 聊天检索判空仍让模型答 | 易编章节 / 来源 | 对齐 RAG：判空不调模型，或禁止引用 |
| **P1** | 该调工具却没调（L5） | 无失败提示 | Evals 标红 + 可选弱提示 |
| **P1** | 「没资料」vs「库空 / 检索异常」话术混 | 用户分不清 | 三种固定用户文案 |
| **P2** | rerank / Mock 静默降级 | 用户不知质量或模式变化 | health 或首条说明 |

---

## 11. 与观测工具的分工

| | ToolTracePanel | LangSmith | Evals (`npm run eval:chat`) |
|--|----------------|-----------|----------------------------|
| 谁看 | 演示 / 当前一句 | 开发者排错 | 改代码后回归 |
| 失败 | tool_call / result | span error、耗时 | pass/fail 规则 |
| 能否替代本表 | 否 | 否 | 部分（行为类），不替代用户话术设计 |
