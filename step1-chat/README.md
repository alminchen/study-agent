# Step 1 · AI Chat

`step1-chat` 是一个用于练习现代 AI 应用链路的全栈示例项目。前端使用 Vue 3、Vite 和 TypeScript，后端使用 Express 与 SSE，编排层使用 LangGraph。

当前代码已经不只包含基础聊天，而是在同一个页面中实现了：

- 单 Agent ReAct：模型在 `askModel -> applyTools -> askModel` 之间循环，直到产出最终文本。
- 多 Agent：Supervisor 路由后并行执行 `realtime`、`kb`、`action`、`general` Worker，再统一汇总。
- 独立 RAG 资料问答：本地 Embedding 检索、分数闸门、重排、提示词拼接和引用展示。
- 工具调用、人工确认、MCP Server、LangSmith 跟踪、Token 用量统计和输入/工具/输出防护。
- Streaming 结构化输出：表格/代码 partial snapshot、最终 Zod 校验、停止和错误终态。
- 学习脚本与评测脚本：可以独立验证切分、Embedding、检索、重排、提示词和 Agent 路由。

项目面向学习和本地验证，不是生产级平台。会话、确认状态、向量库和用量存储目前都采用单进程或本地文件实现。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Vue 3、Vite、TypeScript、`@lucide/vue` |
| API | Express、SSE |
| Agent 编排 | `@langchain/langgraph` |
| 模型调用 | OpenAI 兼容的 `/chat/completions` 接口 |
| RAG | `@huggingface/transformers`、本地 ONNX 模型 |
| 工具协议 | `@modelcontextprotocol/sdk` |
| 跟踪 | LangSmith |
| 校验 | Zod、手写 Function Calling JSON Schema |

## 当前能力

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 单 Agent ReAct | `server/react/` | LangGraph 图结构，最多 5 次模型询问 |
| 多 Agent | `server/multi-agent/` | Supervisor、Worker、Aggregate 三段式编排 |
| RAG 资料问答 | `server/rag/` | 独立于普通聊天的检索增强问答链路 |
| SSE 流式传输 | `server/routes/` | 普通聊天、多 Agent、RAG 均使用 SSE 传输过程事件和文本 |
| 前端 SSE 解析 | `src/api/` | 使用 `fetch + ReadableStream`，不依赖 EventSource |
| 工具调用 | `server/tools/` | 天气、时间、知识库检索、消息起草 |
| 人工确认 | `server/react/confirmGate.ts` | 有后果的工具会暂停，等待前端 `allow` 或 `deny` |
| 输入防护 | `server/guard/inputGuard.ts` | 检测 Prompt Injection，只标记不拦截 |
| 工具防护 | `server/guard/toolCallGuard.ts` | 白名单、参数长度和 JSON 校验 |
| 输出防护 | `server/guard/outputGuard.ts` | 检测系统提示词指纹并替换泄露内容 |
| Token 统计 | `server/usage/` | 请求级累加、SSE 推送、JSON 落盘和成本估算 |
| LangSmith 跟踪 | `server/tracing/langsmith.ts` | 覆盖 chat、multi 和 RAG 请求 |
| Streaming 结构化输出 | `server/routes/chatStructured.ts`、`server/structured/` | 独立 SSE 端点，支持表格/代码稳定快照与最终 schema 校验 |
| MCP Server | `server/mcp/` | 通过 stdio 暴露天气、时间和知识库工具 |
| 回归评测 | `evals/` | 分别评测单 Agent 和多 Agent |

## 三条请求链路

```text
浏览器
  |
  |-- POST /api/chat ----------> 单 Agent ReAct
  |     START -> askModel <-> applyTools -> reply -> END
  |
  |-- POST /api/chat/multi ----> 多 Agent
  |     START -> supervisor -> workers(parallel) -> aggregate -> END
  |
  `-- POST /api/rag/chat ------> RAG
        检索 -> 判空 -> 重排 -> RAG Prompt -> LLM -> Output Guard
```

Vite 开发服务器会把 `/api` 代理到 `http://127.0.0.1:8787`。前端页面本身不直接访问模型。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm
- 单 Agent 普通聊天可以不配置模型 Key；多 Agent 和 RAG 需要可用的 API Key

### 安装与启动

```bash
cd step1-chat
npm install
npm run dev
```

默认地址：

- 前端：http://localhost:5173
- API：http://127.0.0.1:8787

项目当前没有 `.env.example`。请在 `step1-chat/` 下自行创建 `.env` 或 `.env.local`。服务端会先读取 `.env.local`，再读取 `.env`，且 `.env` 不会覆盖已有的 `.env.local` 值。

最小真实模型配置：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

没有 `LLM_API_KEY`，或明确设置 `MOCK_MODE=1` 时，单 Agent 普通聊天（`POST /api/chat`）会进入 Mock 模式。Mock 仍会走完整的 SSE 请求链路，但回复是本地模拟文本，工具不会真正执行。

多 Agent 和 RAG 都没有 Mock 分支，必须有真实 `LLM_API_KEY`，并且 `MOCK_MODE` 不能为 `1`。页面默认开启多 Agent；想体验 Mock，需要先取消勾选“多 Agent”，改用单 Agent。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 空 | OpenAI 兼容接口的 API Key |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 模型接口地址 |
| `LLM_MODEL` | `deepseek-chat` | 默认模型名 |
| `MOCK_MODE` | 未设置 | 设为 `1` 时强制单 Agent 普通聊天使用 Mock；不影响多 Agent 和 RAG 的真实调用要求 |
| `PORT` | `8787` | API 端口 |
| `HOST` | `127.0.0.1` | API 监听地址 |
| `LLM_TOOL_TURN_THINKING` | `disabled` | 兼容分支可设为 `keep`、`on` 或 `enabled` 保留 thinking；当前单 Agent 标准路径显式关闭，详见“安全边界与限制” |
| `CHAT_CANDIDATE_K` | `10` | 普通聊天勾选知识库时的候选数，最大按 20 截断 |
| `CHAT_PREFETCH_HIT_CHARS` | `800` | 普通聊天注入 system 时单段资料的最大字符数 |
| `RAG_WARMUP` | `1` | 服务启动后后台预热 Embedding 和重排模型 |
| `RAG_QUERY_REWRITE` | 关闭 | 开启检索前问句扩写 |
| `RAG_KB_ROUTE` | 关闭 | 开启知识库路由 |
| `RAG_KB_ROUTE_FORCE` | 未设置 | 强制路由到 `notes`、`hr_policy`、`none` 或 `all` |
| `RAG_MULTI_QUERY` | 关闭 | 开启多路召回 |
| `RAG_HYDE` | 关闭 | 开启 HyDE 假文档检索 |
| `RERANK_BATCH_SIZE` | `8` | 重排批大小，限制在 1 到 32 |
| `LANGCHAIN_TRACING_V2` | 未设置 | 设为字符串 `true` 时开启 LangSmith |
| `LANGSMITH_TRACING_V2` | 未设置 | `LANGCHAIN_TRACING_V2` 的等价别名 |
| `LANGCHAIN_TRACING` | 未设置 | 另一个兼容开关 |
| `LANGSMITH_TRACING` | 未设置 | 另一个兼容开关 |
| `LANGCHAIN_API_KEY` | 空 | LangSmith API Key |
| `LANGCHAIN_PROJECT` | 由 LangSmith SDK 决定 | LangSmith 项目名 |

## 页面使用

### 普通对话

普通对话默认走多 Agent，也就是 `POST /api/chat/multi`。取消勾选“多 Agent”后改为 `POST /api/chat`，进入单 Agent ReAct。只有单 Agent 支持 Mock；未配置 Key 时如果仍开启多 Agent，真实模型请求会失败。

页面支持：

- 多轮对话和 SSE 流式显示。
- 模型切换。顶栏列表由 `GET /api/models` 从 `LLM_BASE_URL/models` 读取供应商支持的模型；接口不可用时回退到内置列表。
- 中断当前请求、重试上一条、清空当前模式的历史。
- 显示工具调用过程、人工确认、防护事件和 Token 用量。
- 普通聊天和资料问答分别持久化历史。

普通聊天历史保存在 `localStorage`：

| Key | 内容 |
| --- | --- |
| `step1-chat:history` | 普通聊天历史 |
| `step1-chat:rag-history` | 资料问答历史 |
| `step1-chat:model` | 当前模型 |
| `step1-chat:rag-mode` | 是否处于资料问答模式 |
| `step1-chat:search-kb` | 是否勾选知识库 |
| `step1-chat:multi-agent` | 是否使用多 Agent，缺省为开启 |

### 勾选“搜索知识库”

单 Agent 模式：

1. 服务端在第一次调用模型前执行 `searchDocs`。
2. 检索结果被注入本轮 system prompt。
3. `searchDocs` 工具不会额外暴露给 ReAct 模型。
4. 没有命中时直接返回固定文案，不调用回答模型。

多 Agent 模式：

1. Supervisor 先做路由。
2. 如果路由中没有 `kb` Worker，服务端会强制追加一个 `kb` Worker。
3. `kb` Worker 在自己的 mini ReAct 循环中调用 `searchDocs`。

### 资料问答

资料问答走独立的 `POST /api/rag/chat`，不会回退到 `/api/chat`。

返回内容包含：

- 最终回答。
- `rag_meta` 元信息。
- 原始召回、重排名次和进入 Prompt 的 `[n]` 编号。
- 引用点击与命中面板联动。

## RAG 初始化

RAG 使用两个本地 Hugging Face ONNX 模型：

| 用途 | 模型 | 默认位置 |
| --- | --- | --- |
| Embedding | `Xenova/bge-large-zh-v1.5` | `models/Xenova/bge-large-zh-v1.5` |
| 重排 | `Xenova/bge-reranker-base` | `models/Xenova/bge-reranker-base` |

首次使用先下载模型：

```bash
npm run predawn:bge
npm run predawn:rerank
```

再使用示例 Markdown 入库：

```bash
npm run rag:ingest
```

默认读取 `docs-sample/stage3-rag-notes.md`，写入 `.chroma/my_notes.json`。也可以指定其他 Markdown：

```bash
npm run rag:ingest -- docs-sample/stage5-hr-policy-notes.md
```

完成后启动项目：

```bash
npm run dev
```

打开页面，切换到“资料问答”，再提问已入库文档中的内容。

### RAG 检索流程

```text
用户问题
  -> Input Guard（只标记）
  -> Tool Guard 校验 searchDocs
  -> 可选 Query Rewrite
  -> 可选 KB Route
  -> 可选 Multi-Query 或 HyDE
  -> Embedding 召回
  -> Top1 分数闸门
  -> Reranker
  -> 构造 RAG Prompt
  -> LLM
  -> Output Guard
  -> SSE rag_meta + delta
```

默认参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 候选召回数 | `20` | 向量检索先多取一些候选 |
| 注入数 | `5` | 重排后最多注入 5 段 |
| 最低 Top1 分数 | `0.6` | 防止资料外问题把噪声块注入 Prompt |
| RAG 历史 | 最近 6 条 | 仅保留 user 和 assistant |
| RAG 输出 | 整段一次 `delta` | 当前 RAG 回答不是逐 token 推送 |

标题如果与问句直接匹配，即使向量分数低于 `0.6` 也可以放行。若重排模型不存在，系统会退化为向量 TopK；RAG 路径目前只在服务端日志中提示，不会发送 `degradation` 事件。

### 向量库

当前向量库是项目内的本地 JSON 文件，不是托管向量数据库：

```text
.chroma/my_notes.json
```

同一 `source` 重新入库时会先替换该来源的旧记录。修改切分方式或文档内容后，需要重新运行 `rag:ingest`。

## 单 Agent 实现

入口链路：

```text
POST /api/chat
  -> createChatStream
  -> 截断上下文
  -> 可选 prefetch searchDocs
  -> runConversation
  -> LangGraph ReAct
  -> SSE
```

图结构：

```text
START -> askModel
          |
          | 有 tool_calls
          v
      applyTools
          |
          `------> askModel

askModel 产出最终文本 -> reply -> END
```

实现约束：

- 最多询问模型 5 次，避免 ReAct 无限循环。
- 上下文由 system prompt 加上最近 8 条消息组成。
- 模型 HTTP 调用内部是非流式的，外部仍通过 SSE 推送最终文本。
- 同类工具连续失败达到上限后会停止继续执行，并把失败原因回填给模型。
- `getWeather`、`getCurrentTime` 可直接执行。
- `draft_message` 必须先经过人工确认。

## 多 Agent 实现

入口链路：

```text
POST /api/chat/multi
  -> Input Guard
  -> compileMultiAgentGraph
  -> START
  -> supervisor
  -> workers
  -> aggregate
  -> END
```

Worker 职责：

| Worker | 工具 | 说明 |
| --- | --- | --- |
| `realtime` | `getWeather`、`getCurrentTime` | 处理天气和时间 |
| `kb` | `searchDocs` | 检索资料并基于命中回答 |
| `action` | `draft_message` | 起草或模拟发送消息，需要确认 |
| `general` | 无 | 纯知识回答和兜底 |

Supervisor 通过一次模型调用和伪 `route` 工具产出结构化路由。模型返回非 2xx、未调用 `route`、JSON 无法解析或 Worker 名不在白名单时，都会兜底到 `general`；如果 `fetch` 本身抛出网络异常，当前会直接向上冒泡并结束请求。

Worker 由 `Promise.all` 并行执行。每个 Worker 只暴露自己的工具 schema，不共享模型可见的工具列表。Aggregate 的行为是：

- 只有一个成功 Worker 时直接透传结果。
- 多个 Worker 或存在错误时调用模型汇总。
- 汇总模型失败时拼接 Worker 文本。
- 最终输出始终经过 Output Guard。

当前多 Agent 只用最新的 user 消息，不携带之前的对话历史。

## 人工确认

需要确认的工具当前是 `draft_message`。流程如下：

```text
模型返回 tool_call
  -> SSE pending_confirm
  -> 前端显示确认按钮
  -> POST /api/chat/confirm
  -> ConfirmSession.resolve()
  -> allow：执行工具
  -> deny：不执行，向模型回填拒绝原因
  -> SSE confirm_resolved
  -> 原 SSE 请求继续
```

确认请求体：

```json
{
  "confirmId": "uuid",
  "toolCallId": "tool-call-id",
  "action": "allow"
}
```

`action` 只能是 `allow` 或 `deny`。确认会话保存在进程内存中，所以只适用于单进程运行。聊天请求结束时，未决确认项会按拒绝处理并清理。

## HTTP API

### `GET /api/health`

返回当前运行模式、是否有 Key、模型和 Base URL。

```json
{
  "ok": true,
  "mode": "api",
  "hasApiKey": true,
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1"
}
```

### `GET /api/models`

服务端带 Key 请求 `LLM_BASE_URL/models`，把供应商支持的模型转成前端下拉数据，并过滤掉 `image`、`dall-e`、`flux` 等图片模型。浏览器不会直接接触 API Key。

```json
{
  "models": [
    { "id": "deepseek-v4-flash", "label": "DeepSeek V4 Flash" }
  ],
  "source": "api"
}
```

Mock 模式、上游不可达或响应不是可识别的模型列表时，返回内置兜底列表并把 `source` 标为 `fallback`。

### `POST /api/chat`

单 Agent 聊天，响应类型为 `text/event-stream`。

请求体：

```json
{
  "messages": [
    { "role": "user", "content": "现在几点？" }
  ],
  "model": "deepseek-chat",
  "searchDocs": false
}
```

### `POST /api/chat/multi`

多 Agent 聊天，响应类型为 `text/event-stream`。

请求体与 `/api/chat` 相同。`searchDocs: true` 会强制路由中包含 `kb` Worker。

### `POST /api/rag/chat`

独立资料问答，响应类型为 `text/event-stream`。

请求体：

```json
{
  "question": "为什么改了切分还要重新入库？",
  "history": [
    { "role": "user", "content": "上一个问题" },
    { "role": "assistant", "content": "上一条回答" }
  ],
  "model": "deepseek-chat"
}
```

`history` 只能包含 `user` 和 `assistant`。system prompt 由服务端生成，前端不能覆盖。

### `POST /api/chat/confirm`

放行或拒绝待确认工具调用。成功返回 JSON，不负责执行工具。

确认会话不存在时返回 `404`。工具调用不存在、已处理或 `toolCallId` 错误时也返回 `404`。

### `GET /api/chat/confirm/:confirmId`

调试接口，列出指定确认会话当前挂起的工具调用。

### `GET /api/usage`

返回累计 Token、按 endpoint 和 model 分组的统计，以及最近 50 条记录。

### `DELETE /api/usage`

清空 `data/usage-log.json`。该接口仅供本地 demo 使用，生产环境不应暴露。

## SSE 事件

所有 SSE 数据都以一行 `data: <JSON>` 发送，并以空行分隔。流结束后发送：

```text
data: [DONE]
```

通用事件：

| 事件 | 说明 |
| --- | --- |
| `{ "delta": "..." }` | 文本增量 |
| `{ "error": "..." }` | 请求错误 |
| `{ "type": "usage", ... }` | 本次请求的 Token 和估算成本 |

过程与防护事件：

| `type` | 说明 |
| --- | --- |
| `tool_call` | 模型请求调用工具 |
| `tool_result` | 工具执行结果 |
| `pending_confirm` | 工具等待人工确认 |
| `confirm_resolved` | 用户已允许或拒绝 |
| `injection_detected` | 输入命中注入规则 |
| `output_leak_blocked` | 输出命中系统提示词泄露规则 |
| `degradation` | 发生降级；当前由单 Agent Mock 模式和单 Agent prefetch 重排不可用触发 |
| `searchDocs_empty` | 单 Agent prefetch 检索为空 |

> `react/types.ts` 仍声明了 `searchDocs_result`，但当前实现没有发射这个事件；单 Agent prefetch 的结果通过通用 `tool_result` 展示。

多 Agent 额外事件：

| `type` | 主要字段 | 说明 |
| --- | --- | --- |
| `supervisor_route` | `workers`、`forceKbSearch` | Supervisor 完成路由 |
| `worker_done` | `worker`、`toolsCalled`、`error` | 某个 Worker 已完成 |

RAG 额外事件：

| `type` | 主要字段 | 说明 |
| --- | --- | --- |
| `rag_meta` | `empty`、`calledModel`、`topScore`、`question`、`hits` | 检索和 Prompt 元信息 |

`rag_meta` 还可能包含 `rewriteMeta`、`kbRouteMeta`、`multiQueryMeta` 和 `hydeMeta`，用于展示查询增强结果。

## 工具与 MCP

本地工具注册表位于 `server/tools/index.ts`。

| 工具 | 是否需要确认 | 当前实现 |
| --- | --- | --- |
| `getWeather` | 否 | 学习用天气查询 |
| `getCurrentTime` | 否 | 返回当前日期时间 |
| `searchDocs` | 否 | 调用本地 RAG 检索 |
| `draft_message` | 是 | 只模拟发送，不会真正外发 |

MCP Server 复用相同的工具描述和实现，暴露：

- `getWeather`
- `getCurrentTime`
- `searchDocs`

启动 stdio Server：

```bash
npm run mcp:stdio
```

本地 ping 并列出工具：

```bash
npm run mcp:ping
```

日志必须输出到 stderr，不能写 stdout，否则会破坏 MCP 的 JSON-RPC 通信。

## Token、成本与跟踪

每次聊天类 HTTP 请求创建一个 `UsageAccumulator`。一次用户消息可能触发多次模型调用：

| 链路 | 可能调用 |
| --- | --- |
| `/api/chat` | ReAct 的多次 `askModel` |
| `/api/chat/multi` | Supervisor、多个 Worker、Aggregate |
| `/api/rag/chat` | Query Rewrite、HyDE、最终回答 |
| 检索判空 | 0 次回答模型调用 |

有效用量会：

1. 通过 SSE 发送 `usage` 事件。
2. 追加到 `data/usage-log.json`。
3. 在 `GET /api/usage` 中汇总。

成本由 `server/usage/pricing.ts` 按手工维护的单价估算，不代表模型平台真实账单。

LangSmith 开关只有在变量值严格为字符串 `true` 时才生效：

```env
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=你的 LangSmith Key
LANGCHAIN_PROJECT=step1-chat-dev
```

## 评测

评测需要真实 `LLM_API_KEY`，并且 `MOCK_MODE` 不能为 `1`。

单 Agent：

```bash
npm run eval:chat
npm run eval:chat -- --id time-now
```

多 Agent：

```bash
npm run eval:multi
npm run eval:multi -- --id multi-weather-only
```

数据集：

- `evals/dataset.json`
- `evals/dataset-multi.json`

评测会串行执行，单条请求可能需要数十秒。运行评测时建议关闭 LangSmith，减少额度消耗。

## npm scripts

### 开发与构建

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 Vite 和 Express |
| `npm run dev:web` | 只启动前端 |
| `npm run dev:server` | 只启动 API，使用 `tsx watch` |
| `npm run build` | 运行 Vue/TypeScript 检查并构建前端 |
| `npm run preview` | 预览 Vite 构建结果 |
| `npm run typecheck` | 检查前端和服务端 TypeScript |

### 图表

| 命令 | 说明 |
| --- | --- |
| `npm run diagrams` | 根据脚本数据生成 SVG 时序图 |
| `npm run diagrams:ascii` | 生成终端版 ASCII 流程图 |

### 本地模型

| 命令 | 说明 |
| --- | --- |
| `npm run predawn:bge` | 下载 BGE Embedding ONNX 模型 |
| `npm run predawn:rerank` | 下载 BGE Reranker ONNX 模型 |

### RAG 基础链路

| 命令 | 说明 |
| --- | --- |
| `npm run rag:preview-chunks` | 预览 Markdown 切分结果 |
| `npm run rag:test-embed` | 验证 Embedding 维度、归一化和相似度 |
| `npm run rag:ingest -- [md路径]` | 切分、向量化并替换同来源的旧记录 |
| `npm run rag:test-store` | 验证本地 JSON 向量库读写 |
| `npm run rag:search -- "问题"` | 打印检索 TopK、分数和判空结果 |
| `npm run rag:test-retrieve` | 验证直接命中、近义和资料外问题 |
| `npm run rag:test-empty` | 验证低分闸门和空命中 |
| `npm run rag:preview-prompt -- "问题"` | 打印实际发送给回答模型的 messages |
| `npm run rag:test-prompt` | 验证 RAG Prompt 拼接规则 |
| `npm run rag:ask -- "问题"` | 在终端完成检索、判空、拼 Prompt 和模型调用 |
| `npm run rag:test-rerank` | 对比向量排序与重排后的注入顺序 |

### RAG 查询增强

| 命令 | 说明 |
| --- | --- |
| `npm run rag:rewrite` | 测试问句扩写 |
| `npm run rag:hyde` | 直接测试 HyDE 假文档生成 |
| `npm run rag:compare-enhance` | 对照 Multi-Query 和 HyDE 的召回效果 |
| `npm run rag:test-enhance-fallback` | 验证查询增强失败后的回退 |

### MCP 与评测

| 命令 | 说明 |
| --- | --- |
| `npm run mcp:stdio` | 启动 stdio MCP Server |
| `npm run mcp:ping` | 启动子进程、列出工具并调用示例 |
| `npm run eval:chat` | 运行单 Agent 评测 |
| `npm run eval:multi` | 运行多 Agent 评测 |

带参数调用 npm script 时必须使用 `--`：

```bash
npm run rag:search -- "不要把整篇文档塞进 prompt 冒充 RAG"
npm run rag:preview-prompt -- "今天北京适合出门吗？"
npm run eval:chat -- --id weather-gz
```

## 目录结构

```text
step1-chat/
├── src/
│   ├── api/                 前端 SSE 请求与事件解析
│   ├── components/          聊天、工具轨迹、命中、用量面板
│   ├── composables/         聊天状态、切换、重试、持久化
│   └── rag/                 前端引用工具
├── server/
│   ├── routes/              Express 路由和 SSE 封装
│   ├── react/               单 Agent ReAct / LangGraph
│   ├── multi-agent/         Supervisor、Worker、Aggregate
│   ├── rag/                 RAG 检索、重排、Prompt 和回答
│   ├── guard/               输入、工具、输出防护
│   ├── tools/               工具 Schema 和本地实现
│   ├── mcp/                 MCP Server
│   ├── tracing/             LangSmith 跟踪
│   └── usage/               Token 统计、存储和估价
├── scripts/                 RAG、MCP、图表和评测脚本
├── evals/                   数据集与规则评测
├── docs/                    流程、改造记录和 SVG
├── docs-sample/             示例 Markdown
├── diagrams/                架构和时序图
├── models/                  下载的本地 ONNX 模型，已忽略
├── .chroma/                 本地向量库，已忽略
└── data/                    用量日志，已忽略
```

## 安全边界与限制

- 工具白名单只允许 `getWeather`、`getCurrentTime`、`searchDocs` 和 `draft_message`。
- 工具参数上限为 2048 字符，必须是合法 JSON。
- Input Guard 只标记风险，不会自动阻断请求。
- Output Guard 通过关键短语指纹检测泄露，命中至少两个指纹时替换输出。
- `draft_message` 是学习用假工具，不会真正发送消息。
- ConfirmSession 只存在于单个进程的内存中，多进程部署时无法共享。
- 多 Agent 当前不接收历史对话。
- 普通聊天内部的模型调用不是逐 token 流式，SSE 主要用于传递阶段文本和过程事件。
- RAG 回答目前以整段 `delta` 返回，不是 token 级流式。
- 单 Agent 标准路径固定发送 `thinking: { type: "disabled" }`；虽然 `react/complete.ts` 支持用 `LLM_TOOL_TURN_THINKING=keep/on/enabled` 保留 thinking，但当前 `askModel` 显式传入了关闭选项，因此这个环境变量不会覆盖标准请求路径。
- 本地向量库会在每次检索时加载 JSON，并进行全量余弦相似度计算，不适合大规模数据。
- `DELETE /api/usage` 是演示接口，生产环境不应暴露。
- 项目没有认证、多租户、限流、持久会话或生产级权限控制。

## 常见问题

### 页面显示 Mock，但多 Agent 请求失败

`GET /api/health` 会在没有 Key 时显示 Mock，但 Mock 只接入单 Agent。页面默认开启多 Agent，所以需要填写 `LLM_API_KEY` 后重启 `npm run dev`；或者取消勾选“多 Agent”，改用支持 Mock 的 `/api/chat`。

### RAG 提示需要真实 LLM

RAG 和多 Agent 都不接受 Mock。请确认存在真实 `LLM_API_KEY`，并且 `MOCK_MODE` 不是 `1`。

### 检索时报向量库为空

先执行：

```bash
npm run predawn:bge
npm run rag:ingest
```

### 重排模型不可用

执行：

```bash
npm run predawn:rerank
```

没有重排模型时，系统会退化为向量 TopK。单 Agent prefetch 会通过 `degradation` 事件提示；RAG 路径目前只输出服务端日志。

### 修改文档后检索结果没变化

本地向量库保存的是切分后的向量，不会在每次提问时重新读取 Markdown。修改文档或切分逻辑后必须重新运行 `npm run rag:ingest`。

### 工具轮返回 400

部分 OpenAI 兼容代理不支持 `thinking` 字段。当前单 Agent 标准路径会固定发送：

```json
{ "thinking": { "type": "disabled" } }
```

虽然代码保留了 `LLM_TOOL_TURN_THINKING=keep/on/enabled` 的兼容分支，但当前 `askModel` 显式要求关闭 thinking，环境变量无法覆盖这条路径；遇到该错误需要修改调用参数或更换兼容代理。

### 人工确认接口返回 404

常见原因：

- 原聊天 SSE 已结束。
- `confirmId` 或 `toolCallId` 不正确。
- 该确认项已经被处理。
- 服务进程重启，内存中的 ConfirmSession 已丢失。

## 相关文档

- `docs/flows-index.md`：流程索引
- `docs/structured-output.md`：Streaming 结构化输出阶段总结
- `docs/structured-output-flow.svg`：Streaming 结构化输出全链路图
- `docs/project-messages-flow.md`：消息组装与调用链
- `docs/rag-query-enhance-notes.md`：RAG 查询增强
- `docs/human-confirm-changelog.md`：人工确认设计记录
- `docs/multi-agent-human-confirm-changelog.md`：多 Agent 确认流程
- `docs/rag-input-output-guard-changelog.md`：RAG 防护改造
- `server/routes/README.md`
- `server/react/README.md`
- `server/multi-agent/README.md`
- `server/rag/README.md`
- `server/usage/README.md`
- `server/mcp/README.md`
