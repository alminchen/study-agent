# RAG · Guard / SSE Trace / LangSmith · 修改记录

> 对照：`learning-plan` 能力缺口补齐  
> **状态：已接入**（input + tool + output Guard · SSE Trace · LangSmith）  
> 日期：2026-08-21  
> 拓扑：[`project-topology.html`](./project-topology.html) §6 / §7 · 泳道：[`rag-chat-flow.svg`](./rag-chat-flow.svg)

---

## 一句话

`/api/rag/chat` 与单 Agent **对齐横切语义**：三道 Guard + SSE 过程事件 + LangSmith span。  
通道从 **整包 JSON** 改为 **SSE**（`rag_meta` + `delta` + `usage` + `[DONE]`）；检索前对内部召回走 `validateToolCall("searchDocs")`。

---

## 行为变化（相对仅 input/output Guard 时）

| 场景 | 改前 | 改后 |
|------|------|------|
| 响应形态 | `res.json({ answer, hits, usage, injection? })` | **SSE**：过程事件 → `rag_meta` → `delta` → `usage?` → `[DONE]` |
| Tool Guard | 无（宣称不适用） | 检索前 `validateToolCall("searchDocs", { question })`；拒绝则不 retrieve、不调模型 |
| SSE Trace | 无 | `injection_detected` / `tool_call` / `tool_result` / `output_leak_blocked` → ToolTracePanel |
| LangSmith | 无 | `rag-request` → `rag-retrieve` → `rag-llm`（需 `LANGCHAIN_TRACING_V2=true`） |
| 前端 askRag | 等完整 JSON | 解析 SSE（同 streamChat 形态） |

仍保留：Token `source=rag`；判空 0 次 LLM；命中面板靠 `rag_meta.hits`（RagHitPanel）。

---

## 新增 / 扩展（服务端）

| 路径 | 做什么 |
|------|--------|
| `server/tracing/langsmith.ts` | **增补** `traceRagRequest` / `traceRagRetrieve` / `traceRagLlm` + `runRagRetrieveWithTracing` / `runRagLlmWithTracing` |

---

## 修改文件（服务端）

| 路径 | 改了什么 |
|------|----------|
| `server/routes/ragChat.ts` | 改为 `setSseHeaders`；Input → SSE `injection_detected`；`answerFromDocs(..., onTrace)`；写出 `rag_meta` + `delta`；`writeUsageToStream`；可选 `traceRagRequest` 包整段 |
| `server/rag/answer.ts` | 检索前 toolGuard；`onTrace` 推 tool_* / output_leak；retrieve/LLM 走 LangSmith 包装；`toolGuardBlocked?` |
| `server/routes/sse.ts` | 注释：调用方含 `/api/rag/chat` |
| `server/routes/README.md` | ragChat 一行改为 SSE + 全套横切 |

---

## 修改文件（前端）

| 路径 | 改了什么 |
|------|----------|
| `src/api/rag.ts` | 改为 SSE 解析：`onDelta` / `onTrace` / `onUsage` / `onRagMeta` |
| `src/composables/useChat.ts` | `runRag` 对齐 `runStream`（过程进 toolTrace，命中进 `message.rag`） |
| `src/types.ts` | `ToolTraceStep` 增补 `injection_detected` / `output_leak_blocked` |
| `src/components/ToolTracePanel.vue` | 展示上述两类防护事件 |
| `src/api/chat.ts` | 同步解析 injection / output_leak（单/多 Agent 面板也能看到） |

---

## 修改文件（文档）

| 路径 | 改了什么 |
|------|----------|
| `docs/rag-input-output-guard-changelog.md` | 本记录（扩成 Guard+Trace+LangSmith） |
| `docs/rag-chat-flow.svg` | SSE / toolGuard / LangSmith 流程图 |
| `docs/crosscutting-token-guard-trace-flow.svg` | 矩阵与 RAG 对照改为全 ✅ |
| `docs/project-topology.html` | §6 / §7 RAG 缺口消除 |
| `docs/flows-index.md` / `.html` | rag 一行说明更新 |
| `docs/project-messages-flow.md` | §五 SSE 事件与 Guard/Trace 说明 |

---

## SSE 事件顺序（浓缩）

```
POST /api/rag/chat
  → setSseHeaders
  → detectInjection → [injection_detected?]
  → UsageAccumulator + bindUsage("rag")
  → [LangSmith] traceRagRequest
       → answerFromDocs
            → tool_call(searchDocs)
            → validateToolCall ──拒绝──→ tool_result{error} → rag_meta → delta → …
            → [LangSmith] rag-retrieve → retrieveForAnswer
            → tool_result{empty, topScore, hitCount…}
            → buildRagPrompt →（空则跳过 LLM）
            → [LangSmith] rag-llm → completeRagMessages → onUsage
            → detectLeakage → [output_leak_blocked?]
       → rag_meta{ hits, empty, … }
       → delta(answer)
  → writeUsageToStream（有 LLM 时）
  → [DONE]
```

---

## LangSmith span 树（开关打开时）

```
rag-request          chain
  ├─ rag-retrieve    tool   （searchDocs 语义 / 实际 retrieveForAnswer）
  └─ rag-llm         llm    （有资料才有；判空则无）
```

---

## 手测建议

| 状态 | 场景 | 期望 |
|------|------|------|
| [ ] | 正常资料问句 | Trace 有 searchDocs tool_call/result；气泡有答案；RagHitPanel 有 hits；有 usage |
| [ ] | 问句含注入话术 | Trace 有「输入防护」；仍继续检索/回答 |
| [ ] | 资料外问句（判空） | tool_result.empty=true；calledModel=false；无 usage |
| [ ] | `LANGCHAIN_TRACING_V2=true` | LangSmith 出现 `rag-request` 树 |
| [ ] | 打开拓扑 / rag-chat-flow / 横切 SVG | 不再写「RAG 无 toolGuard / SSE / LangSmith」 |

---

## 修订历史

| 日期 | 说明 |
|------|------|
| 2026-08-21 | 首轮：RAG 接入 input/output Guard（仍 JSON） |
| 2026-08-21 | 二轮：补 ToolGuard + SSE Trace + LangSmith；前端改为 SSE |
