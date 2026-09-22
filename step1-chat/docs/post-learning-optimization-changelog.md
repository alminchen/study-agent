# study-chat · post-learning 优化落地记录

> 依据：`../post-learning-optimization-plan.md`  
> 载体：本目录 `study-chat`（与 `step1-chat` 学习原版分离）  
> 拍板：**知识库语义 C** — 勾选 = 服务端必检索（prefetch）+ ReAct 本轮不挂 `searchDocs`

---

## 已做

### P0 · 工具轮关 thinking
- `server/react/complete.ts`：带 tools 的请求默认附带 `thinking: { type: "disabled" }`
- 环境变量：`LLM_TOOL_TURN_THINKING=disabled`（默认）；代理不支持时改为 `keep`
- LangSmith LLM span 改名为 **`chat-llm`**（避免与 LangGraph 节点 `askModel` 同名叠两层）

### P0 · 知识库语义 C
- `requestCompletion` **固定** `includeSearchDocs=false`
- 勾选仍走 `prefetchSearchDocsIfEnabled` → 注入本轮 system
- system 文案明确「无需再调 searchDocs」；UI 标注「必检索」
- `searchDocs` 工具仍在注册表 / MCP / multi `kbWorker` 可用
- **多 Agent + 勾选搜索**：`forceKbSearch` — Supervisor 后若无 `kb` 则强制追加，由 `kbWorker` 调 `searchDocs`

### P1 · 观测
- 新增 **`chat-prefetch`** span（`runPrefetchWithTracing`）
- chat LLM span 名称：`chat-llm`

### P1 · 检索降配（聊天路径）
- `CHAT_CANDIDATE_K=10`（默认）传入 `retrieveForAnswer`
- 资料问答 `/api/rag/chat` 仍用 `CANDIDATE_K=20`
- 注入 system 时截断 hit：`CHAT_PREFETCH_HIT_CHARS=800`
- **启动预热**：`RAG_WARMUP=1` → `warmRagModels()`（listen 后后台加载 embed + rerank）
- **rerank batch**：`RERANK_BATCH_SIZE=8` 分批打分；单批失败回退串行

### P2 · 结构
- `runConversation.forLoop.ts` 标明「仅文档对照，勿改现网」
- 双入口保留：主路径文案区分——「资料问答」整页 vs 勾选「搜索知识库（必检索）」

---

## 刻意未做 / 后置

| 项 | 原因 |
|----|------|
| 最终轮真流式 | 现网末轮文字来自带 tools 的非流式 completion；真流式需拆「无 tools 再请求」或流式解析 tool_calls，单独立项 |
| MCP schema 单一来源 | 低优先级，未并进本轮 |
| 关 KB 时强剥离历史 `[n]` | 可用 eval `kb-toggle-off` 另开；本轮仅强化 system OFF 文案 |
| 伪造 tool_calls / 图外预路由 | 文档明确禁止 |

---

## 验收建议

1. 单 Agent + 勾选知识库：Trace 见 `searchDocs`（prefetch），模型 tools 列表应无 `searchDocs`
2. 「广州天气，顺便查几点」：仍调天气/时间；若代理支持 disabled thinking，首轮应明显更快
3. 若 400 且 body 含 thinking：`.env` 设 `LLM_TOOL_TURN_THINKING=keep`
4. `npx tsc -p tsconfig.server.json --noEmit`；有 Evals 时再跑 `npm run eval:chat`

---

## 关键文件

- `server/react/complete.ts`
- `server/react/prefetchSearchDocs.ts`
- `server/react/types.ts` / `runConversation.ts`
- `server/chat.ts`
- `server/tools/index.ts` / `methods/searchDocs.ts`
- `server/rag/retrieve.ts`
- `server/rag/rerank.ts` / `embedding.ts` / `warmup.ts`
- `server/index.ts`（listen 后 warmRagModels）
- `server/tracing/langsmith.ts`
- `src/App.vue` / `src/api/chat.ts`
- `.env`
