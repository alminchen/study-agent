# Step 1 · AI Chat

`step1-chat` 是一个用于练习现代 AI 应用链路的全栈示例项目。前端使用 Vue 3、Vite 和 TypeScript，后端使用 Express 与 SSE，编排层使用 LangGraph。

当前代码已经不只包含基础聊天，而是在同一个页面中实现了：

- 单 Agent ReAct：模型在 `askModel -> applyTools -> askModel` 之间循环，直到产出最终文本。
- 多 Agent：Supervisor 路由后并行执行 `realtime`、`kb`、`action`、`general` Worker，再统一汇总。
- 独立 RAG 资料问答：本地 Embedding 检索、分数闸门、重排、提示词拼接和引用展示。
- 工具调用、人工确认、MCP Server、LangSmith 跟踪、Token 用量统计和输入/工具/输出防护。
- Streaming 结构化输出：表格/代码 partial snapshot、最终 Zod 校验、停止和错误终态。
- Plan-and-Execute：规则路由后先规划再执行，支持受控 Re-plan、计划时间线和人工确认边界。
- 长上下文管理：按 Token 预算保留近期原文，并用结构化摘要压缩更早对话，摘要失败自动降级。
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
| SSE 流式传输 | `server/routes/` | 普通聊天、Plan、Structured、多 Agent、RAG 均使用 SSE 传输过程事件和结果 |
| 前端 SSE 解析 | `src/api/` | 使用 `fetch + ReadableStream`，不依赖 EventSource；记忆事件统一由 `api/memoryTrace.ts` 解析 |
| 跨会话长期记忆 | `server/memory/` | 路由层检索一次注入上下文，对话结束抽取用户事实；普通对话、multi、plan、rag、structured 五条链路已接入，反思复盘未接入 |
| 工具调用 | `server/tools/` | 天气、时间、知识库检索、消息起草 |
| 人工确认 | `server/react/` | 有后果的工具会暂停，等待前端 `allow` 或 `deny` |
| 输入防护 | `server/guard/` | 检测 Prompt Injection，只标记不拦截 |
| 工具防护 | `server/guard/` | 白名单、参数长度和 JSON 校验 |
| 输出防护 | `server/guard/` | 检测系统提示词指纹并替换泄露内容 |
| Token 统计 | `server/usage/` | 请求级累加、SSE 推送、JSON 落盘和成本估算 |
| LangSmith 跟踪 | `server/tracing/` | 覆盖 chat、multi 和 RAG 请求 |
| Streaming 结构化输出 | `server/structured/` | 独立 SSE 端点，支持表格/代码稳定快照与最终 schema 校验 |
| Plan-and-Execute | `server/plan-execute/` | 规则路由、Planner、顺序 Executor、受控 Re-plan 和计划时间线 |
| 长上下文管理 | `server/context/`、`server/chat.ts`、`server/routes/chatMulti.ts` | Token 预算、结构化摘要、工具消息配对和摘要失败回退；单 Agent 与多 Agent Worker 均已接入 |
| MCP Server | `server/mcp/` | 通过 stdio 暴露天气、时间和知识库工具 |
| LLM-as-Judge 语义判定 | `server/guard/` | 输入 / 检索片段 / 输出三个判定面，off / shadow / enforce 三档 |
| Reflection 自我评估 | `server/reflection/` | 独立端点，四维评分与达标重写，默认关闭不影响日常聊天 |
| 图片输入（Vision） | `server/vision/` | 前端压缩 → 服务端硬校验 → 模型能力判定 → 供应商 content parts 转换 |
| 检索前查询增强 | `server/rag/queryEnhance/` | 意图拆解、问句扩写、多知识库路由、Multi-Query 和 HyDE |
| 动态知识库 | `server/kb/` | 上传 → 切片 → 异步入库 → 可检索；分类硬边界 + RAG 双库合并衔接（全库搜 / 分类过滤） |
| 记忆管理接口 | `server/routes/memory.ts` | 用户可查看、改值、软删除和清空自己的记忆 |
| 回归评测 | `evals/` | 分别评测单 Agent 和多 Agent |

### 功能入口与 Mock 范围

| 功能 | 端点 | 页面入口 | Mock | 持久化 |
| --- | --- | --- | --- | --- |
| 单 Agent ReAct | `/api/chat` | 关闭多 Agent，保持普通输出且不开启计划 | 支持 | 普通聊天历史、上下文摘要 |
| Plan-and-Execute | `/api/chat/plan` | 开启计划开关，并选择 `auto`、`react` 或 `plan` | 支持 | 普通聊天历史；计划时间线不单独持久化 |
| Streaming Structured | `/api/chat/structured` | 选择表格或代码；普通输出不选目标 | 支持 | 普通聊天历史中只保存完整结果 |
| 多 Agent | `/api/chat/multi` | 保持多 Agent 开启，使用普通文本输出且不开启计划 | 不支持 | 普通聊天历史、上下文摘要（只注入 Worker） |
| RAG 资料问答 | `/api/rag/chat` | 切换到“资料问答” | 不支持 | 独立 RAG 历史 |
| Reflection 复盘 | `/api/chat/reflection` | 独立复盘入口 | 不支持 | 不持久化 |
| 图片输入 | `/api/chat`、`/api/chat/multi` | 开启图片输入开关后粘贴或选择图片 | 随主链路，Mock 不真正识图 | 只存图片元数据，不存 base64 |

Mock 指本地模拟模型流或回答，不等于真实模型验收。多 Agent 和 RAG 都必须有真实
`LLM_API_KEY`，且 `MOCK_MODE != 1`。上表来自当前源码和文档的静态核对；本轮 README
更新没有重新调用真实模型，也没有执行浏览器验收或 50 轮长会话压测。

## 主要请求链路

```text
浏览器
  |
  |-- POST /api/chat ----------> 单 Agent ReAct
  |     START -> askModel <-> applyTools -> reply -> END
  |
  |-- POST /api/chat/multi ----> 多 Agent
  |     START -> supervisor -> workers(parallel) -> aggregate -> END
  |
  |-- POST /api/chat/plan -----> Plan-and-Execute
  |     classify -> planner -> executor -> maybe_replan -> reply
  |
  |-- POST /api/chat/structured
  |     provider stream -> partial parser -> stable snapshot -> final schema
  |
  `-- POST /api/rag/chat ------> RAG
        检索 -> 判空 -> 重排 -> RAG Prompt -> LLM -> Output Guard
```

Vite 开发服务器会把 `/api` 代理到 `http://127.0.0.1:18787`。前端页面本身不直接访问模型。

## 快速开始

### 环境要求

- Node.js 20 或更高版本
- npm
- 单 Agent 普通聊天、Plan 和 Structured 可以不配置模型 Key；多 Agent 和 RAG 需要可用的 API Key

### 安装与启动

```bash
cd step1-chat
npm install
npm run dev
```

默认地址：

- 前端：http://localhost:5173
- API：http://127.0.0.1:18787

仓库提供 `.env.example` 作为模板，但 `.env` 和 `.env.local` 都不在 Git 里，需要自己创建一次：

```bash
cp .env.example .env
```

服务端启动时先读 `.env.local`，再读 `.env`，且 `.env` 不会覆盖 `.env.local` 里已有的值。完整变量清单见「环境变量」一节。

最小真实模型配置：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

没有 `LLM_API_KEY`，或明确设置 `MOCK_MODE=1` 时，以下端点会进入 Mock 模式：

- `POST /api/chat`
- `POST /api/chat/plan`
- `POST /api/chat/structured`

Mock 仍会走对应的 SSE 请求链路，但回复或结构化结果是本地模拟数据，不会产生真实模型用量。
Plan Mock 只复述真实执行过的模拟步骤；Structured Mock 会模拟 partial JSON 和稳定快照。

多 Agent 和 RAG 都没有 Mock 分支，必须有真实 `LLM_API_KEY`，并且 `MOCK_MODE` 不能为 `1`。页面默认开启多 Agent；想体验 Mock，需要先取消勾选“多 Agent”，改用单 Agent。

## 环境变量

### 两个 env 文件的分工

服务端启动时按固定顺序加载：先 `.env.local`，再 `.env`，**后加载的不会覆盖前面已经读到的值**，所以 `.env.local` 优先级更高。

| 文件 | 放什么 | 是否进 Git |
| --- | --- | --- |
| `.env` | 可公开的通用配置：模型名、接口地址、功能开关、超时、批大小 | 否，`.gitignore` 已忽略 |
| `.env.local` | 本机私有值：`LLM_API_KEY`、`LANGCHAIN_API_KEY` 等密钥 | 否，`.gitignore` 已忽略 `*.local` |

两个文件本身都不在仓库里，仓库只提供 `.env.example` 作为模板。首次拉取后创建一次：

```bash
cp .env.example .env
```

密钥写进 `.env.local`，不要写进 `.env`，也不要把 `.env.local` 提交：

```env
LLM_API_KEY=你的 API Key
LANGCHAIN_API_KEY=你的 LangSmith Key
```

几个容易踩的点：

- 下表所有变量写在 `.env` 或 `.env.local` 都生效，同名时以 `.env.local` 为准。
- 前端不读这两个文件里的密钥，所有模型调用都发生在服务端，浏览器里看不到 `LLM_API_KEY`。
- dotenv 只在进程启动时读一次，改完 `.env` / `.env.local` 要重启服务才生效。
- `.env.example` 只列变量名和默认值，不含任何真实 Key，可以直接提交。

### 模型与服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 空 | OpenAI 兼容接口的 API Key；留空或 `MOCK_MODE=1` 时 chat / plan / structured 走 Mock |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | 模型接口地址 |
| `LLM_MODEL` | `deepseek-chat` | 默认模型名；Judge 未单独指定时也用它 |
| `MOCK_MODE` | 未设置 | 设为 `1` 强制 Mock；多 Agent 和 RAG 没有 Mock 分支，仍需真实 Key |
| `PORT` | `18787` | API 端口 |
| `HOST` | `127.0.0.1` | API 监听地址 |
| `NODE_ENV` | 未设置 | 设为 `test` 时不打工具发现日志，跑测试时用来压掉噪声 |

### 长上下文预算

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_CONTEXT_WINDOW_TOKENS` | `64000` | 上下文窗口估计值，用于计算 Token 预算 |
| `LLM_CONTEXT_BUDGET_RATIO` | `0.5` | 预算占窗口的比例，必须大于 `0` 且不超过 `1` |

### Structured 输出

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_STRUCTURED_JSON_MODE` | 开启 | 设为 `0` 时 Structured 默认改用 prompt-only 约束 |
| `LLM_STRUCTURED_INCLUDE_USAGE` | 开启 | 设为 `0` 时不向供应商请求流末尾 usage |
| `LLM_STRUCTURED_CONNECT_TIMEOUT_MS` | `15000` | 建立连接超时；`0` 表示关闭 |
| `LLM_STRUCTURED_FIRST_CHUNK_TIMEOUT_MS` | `30000` | 等待首个内容 chunk 的超时；`0` 表示关闭 |
| `LLM_STRUCTURED_TOTAL_TIMEOUT_MS` | `180000` | 整次流式请求超时；`0` 表示关闭 |

### 输出判定（Judge）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `JUDGE_MODE` | `off` | 唯一开关：`off` / `shadow` / `enforce`；非法值回落 `off` 并告警一次 |
| `JUDGE_MODEL` | 沿用 `LLM_MODEL` | 判定使用的模型 |
| `JUDGE_BASE_URL` | 沿用 `LLM_BASE_URL` | 判定模型的接口地址 |
| `JUDGE_API_KEY` | 沿用 `LLM_API_KEY` | 判定模型的 Key |
| `JUDGE_CONNECT_TIMEOUT_MS` | `2000` | 建立连接超时；`0` 表示关闭 |
| `JUDGE_FIRST_CHUNK_TIMEOUT_MS` | `5000` | 等待首个内容 chunk 的超时；`0` 表示关闭 |
| `JUDGE_TOTAL_TIMEOUT_MS` | `8000` | 整次判定超时；`0` 表示关闭 |
| `JUDGE_MAX_INPUT_CHARS` | `4000` | 送进判定的文本上限；`0` 表示不截断 |
| `JUDGE_CONFIDENCE_THRESHOLD` | `0.6` | 置信度阈值，取值范围 `0` 到 `1`（含两端） |

判定模型配置刻意与主对话模型解耦：主模型繁忙或降级时，Guard 不应该跟着变慢或失效。详见 `docs/llm-judge.md`。

### 自我评估（Reflection）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REFLECTION_MODE` | `off` | `off` / `shadow` / `enforce`；非法值回落 `off` 并告警一次 |

服务端 `REFLECTION_MODE` 是上限，请求里带的模式只能往下调。详见 `docs/reflection.md`。

### 多模态（Vision，实施中）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VISION_CAPABLE_MODELS` | 未设置 | 逗号分隔的模型白名单；一旦设置就不再走模型名启发式判断 |

能力判定优先级：环境变量白名单 > 模型 id 启发式（`gpt-4o` / `gpt-5` / `vision` / `omni` / `qwen-vl` 等）> 运行期降级（带图请求被供应商拒绝时把该模型在本进程内标记为不支持）。图片字节数、像素尺寸和每次请求的图片数量当前是代码常量（1MB / 4096px / 每次 1 张），暂不可配。详见 `docs/vision.md`。

### RAG 与检索

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAG_QUERY_REWRITE` | 关闭 | 开启检索前问句扩写 |
| `RAG_KB_ROUTE` | 关闭 | 开启知识库路由 |
| `RAG_KB_ROUTE_FORCE` | 未设置 | 强制路由到 `notes`、`hr_policy`、`none` 或 `all` |
| `RAG_MULTI_QUERY` | 关闭 | 开启多路召回 |
| `RAG_HYDE` | 关闭 | 开启 HyDE 假文档检索 |
| `RAG_WARMUP` | `1` | 服务启动后后台预热 Embedding 和重排模型 |
| `CHAT_CANDIDATE_K` | `10` | 普通聊天勾选知识库时的候选数，最大按 20 截断 |
| `CHAT_PREFETCH_HIT_CHARS` | `800` | 普通聊天注入 system 时单段资料的最大字符数 |
| `RERANK_BATCH_SIZE` | `8` | 重排批大小，限制在 1 到 32 |

### 工具轮

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_TOOL_TURN_THINKING` | `disabled` | 兼容分支可设为 `keep`、`on` 或 `enabled` 保留 thinking；当前单 Agent 标准路径固定关闭 thinking，该变量不覆盖标准路径，详见「安全边界与限制」 |

### LangSmith 追踪

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LANGCHAIN_TRACING_V2` | 未设置 | 设为字符串 `true` 时开启 LangSmith |
| `LANGSMITH_TRACING_V2` | 未设置 | `LANGCHAIN_TRACING_V2` 的等价别名 |
| `LANGCHAIN_TRACING` | 未设置 | 另一个兼容开关 |
| `LANGSMITH_TRACING` | 未设置 | 另一个兼容开关 |
| `LANGCHAIN_API_KEY` | 空 | LangSmith API Key |
| `LANGCHAIN_PROJECT` | 由 LangSmith SDK 决定 | LangSmith 项目名，只是 trace 的分组名 |

四个开关任意一个为 `true` 即开启 tracing。`LANGCHAIN_PROJECT` 不决定 workspace，workspace 由 API Key 决定。

### 仅脚本使用

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CHAIN_TEST_PORT` | `8899` | 链路自测脚本启动的服务端口 |
| `CHAIN_FILTER` | 空 | 只跑指定标签的链路，空表示全跑 |
| `PLAN_TASK` | Vue 3 与 Vue 2 对比 | 链路自测里 Plan 使用的任务文本 |
| `PLAN_TIMEOUT_MS` | `240000` | 链路自测里 Plan 的超时 |

这几个只在跑链路自测脚本时生效，服务本身不读。

### 取值非法时的行为

- 整数型超时和上下文窗口：只接受非负整数，非法值或负数回退默认值。
- `LLM_CONTEXT_BUDGET_RATIO`：必须大于 `0` 且不超过 `1`，否则回退默认值。
- `JUDGE_CONFIDENCE_THRESHOLD`：必须落在 `0` 到 `1`（含两端），否则回退默认值。
- `JUDGE_MODE` / `REFLECTION_MODE`：非法值回落到 `off`，打一条警告，不抛错、不阻塞启动。
- `CHAT_CANDIDATE_K` / `RERANK_BATCH_SIZE`：越界时夹到合法区间，不报错。

## 页面使用

### 普通对话

普通对话默认走多 Agent，也就是 `POST /api/chat/multi`。取消勾选“多 Agent”后改为 `POST /api/chat`，进入单 Agent ReAct。只有单 Agent 支持 Mock；未配置 Key 时如果仍开启多 Agent，真实模型请求会失败。

页面支持：

- 多轮对话和 SSE 流式显示。
- 模型切换。顶栏列表由 `GET /api/models` 从 `LLM_BASE_URL/models` 读取供应商支持的模型；接口不可用时回退到内置列表。
- 中断当前请求、重试上一条、清空当前模式的历史。
- 显示工具调用过程、人工确认、防护事件和 Token 用量。
- 普通聊天和资料问答分别持久化历史。
- Plan 模式路由、计划时间线、步骤状态、Re-plan 和回退原因。
- Structured 的普通文本、表格、代码三种输出选择，以及稳定快照增量渲染。

普通聊天历史保存在 `localStorage`：

| Key | 内容 |
| --- | --- |
| `step1-chat:history` | 普通聊天历史 |
| `step1-chat:rag-history` | 资料问答历史 |
| `step1-chat:model` | 当前模型 |
| `step1-chat:rag-mode` | 是否处于资料问答模式 |
| `step1-chat:search-kb` | 是否勾选知识库 |
| `step1-chat:multi-agent` | 是否使用多 Agent，缺省为开启 |
| `step1-chat:plan-enabled` | 是否使用 Plan-and-Execute 端点，缺省为关闭 |
| `step1-chat:plan-mode` | Plan 路由模式，值为 `auto`、`react` 或 `plan` |
| `step1-chat:context-summary` | 服务端压缩后回传的结构化上下文摘要 |

### 计划模式

普通聊天右上角可以开启计划开关，并选择：

- `auto`：规则分类器根据任务是否包含顺序、研究后产出或多能力信号决定 ReAct 或 Plan。
- `react`：跳过 Planner，直接走单 Agent ReAct。
- `plan`：显式进入 Plan-and-Execute；计划不合法或规划失败时仍可回退 ReAct。

计划生成后会先显示时间线，再逐步执行。停止请求时，已完成步骤保持完成，未执行或正在执行的
步骤会标记为 `skipped`。Re-plan 最多一次；用户拒绝人工确认后，不会通过 Re-plan 绕过确认。
计划开关与 Structured 目标互斥，Structured 模式下计划开关不可用。

### Structured 输出

普通聊天可选择三种输出：普通文本、表格、代码。

- 表格和代码请求走 `/api/chat/structured`；普通文本仍走 ReAct、Plan 或多 Agent。
- 服务端只把通过快照 Schema 的稳定结果作为 `structured_snapshot` 推送，前端按 revision 增量渲染。
- 停止请求时保留最后一个稳定快照，但不会把它标记为最终完成结果。
- 错误终态可以重试；重试会沿用原消息的 `target`，不会因为选择器切换而改跑另一种结构。
- RAG 模式会隐藏 Structured 目标选择器；Structured 模式会禁用计划开关。

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

### 动态知识库

动态知识库是独立于 `.chroma/my_notes.json` 的第二套本地库，位于 `server/kb/`，
与静态离线库并存。它的特点是**上传后异步切片、异步入库**，用户可实时看到任务进度，
并按**分类硬边界**检索；步骤 4 起 RAG 采用「离线库 + 动态库」**双库合并式召回**，
两套候选按分数合并排序后统一走判空闸门与重排。

数据层（`data/kb/`）四张表 + 原件目录：

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 分类表 | `data/kb/categories.json` | `id` / `name` / `createdAt`，分类是检索硬边界 |
| 任务表 | `data/kb/tasks.json` | 上传任务记录与状态机当前节点 |
| 块表 | `data/kb/chunks.json` | Markdown 切块原文，按 `docId` 归属 |
| 向量表 | `data/kb/vectors.json` | 每块的 1024 维 embedding |
| 原件目录 | `data/kb/uploads/{docId}/` | 上传的原始 Markdown 文件 |

#### 上传链路（写，秒回）

`POST /api/kb/upload` 只做「收件」：校验文件名（取 basename 防路径穿越）、
扩展名（只收 `.md`）、大小（1MB）、分类非空，然后落盘原件、登记一条
`queued` 任务，立即返回任务记录。**切片与 embedding 不在请求里做**，否则
「传个文件」会变成「等模型跑完」，上传是可感知的同步操作，必须秒回。

上传走 JSON + base64（项目无 multer 依赖，零新增依赖），请求体：

```json
{
  "filename": "notes.md",
  "content": "<base64>",
  "category": "学习计划"
}
```

#### 后台推进（状态机）

`server/kb/worker.ts` 每 2 秒跑一轮，按状态机推进：

```text
queued -> chunking -> chunked -> embedding -> searchable
   |          |          |           |            |
   +----------+----------+-----------+------------+-> failed(read / chunk / embed)
```

每个状态的含义与推进者：

| 状态 | 含义 | 谁推进 |
| --- | --- | --- |
| `queued` | 上传刚落盘原件，在排队 | worker 认领 |
| `chunking` | 已被认领，正在切 Markdown | 切片阶段 |
| `chunked` | 已切完、块已落块表，但无向量 | worker 认领（块预览专用中间态） |
| `embedding` | 正在逐批 embedding | 入库阶段 |
| `searchable` | 向量已入库，可被检索命中 | 完成态 |
| `failed` | 停在 `read` / `chunk` / `embed` 某一层 | 用户点重试 |

设计要点：

- **认领即置位**：worker 取活时把任务从 `queued` / `chunked` 原子改为处理中，
  天然防重入，别的循环实例不会重复取同一任务。
- **失败可定位**：每步失败都落 `stage` + `error` 到任务上，绝不吞异常让任务
  永远停在排队；重试把任务复位 `queued`，`docId` 不变，不会重复建文档。
- **分批 embed**：单批 32 块，防止几百块一次性塞给 embedding 打爆内存或触发限流。
- **全部 embed 完才一次写盘**：中途失败不落半个文档，库里永远只有完整版。
- **替换语义**：同「分类 + 文件名」复用同一 `docId`，入库先清旧块再写新块。

#### 分类管理

`GET /api/kb/categories` 列出全部类，`POST /api/kb/categories` 建类。
分类名去空白后不能为空，同名去重（重复建返回已有 `id`）。分类是检索的
**硬边界**，不靠 prompt 约束：上传必须选一个类，块与向量都按类归属。

#### 检索链路（读，供 RAG / 知识库搜索）

`server/kb/search.ts` 的 `askKnowledge({ question, category, topK })`：

1. 校验问题非空，`topK` 收敛到 1..20（缺省 5）。
2. 只 embed 提问这一句（绝不 embed 整库）。
3. 分支：`category` 有值 → `searchByCategory` 硬过滤；无值/空串 → `searchAll` 全库扫。
4. 命中映射为对外形状（丢弃 1024 维向量，省流量），带 `category` / `source` / `seq`。

`POST /api/kb/search` 暴露给前端做知识库页检索；RAG 内部走 `askKnowledge` 而非该端点。

#### RAG 双库合并衔接

`server/rag/retrieve.ts` 的 `retrieve()` 采用**合并式**：

```text
question
  -> embed 一次给离线库
  -> 离线库 LocalVectorStore.search(topK)        （空库 -> []）
  -> 动态库 askKnowledge({ question, category, topK })   （空库 -> []）
  -> kbHitToSearchHit 适配成 SearchHit（id/source = 分类__文件名__块序号）
  -> 两套候选按 score 降序合并，截断到 topK
  -> 判空闸门 -> 重排
```

`category` 由 `/api/rag/chat` 请求体可选字段透传：有值 → 动态库只在该分类内搜，
无值 → 动态库全库搜。`kbHitToSearchHit` 把 `KbAskHit` 适配成 `SearchHit`，
`id` / `source` 用「分类__文件名__块序号」拼接，与离线 `source` 天然不撞、
可逆拆回；前端 `RagHitPanel.vue` 的 `splitSource()` 按 `__` 拆出分类标签展示。

#### 任务管理端点

`GET /api/kb/tasks` 返回任务列表 + 每篇文档实时块数；`GET /api/kb/chunks?docId=`
预览块；`POST /api/kb/delete` 按 `docId` 四环事务删除（向量 → 块 → 任务 → 原件，
先清「可被搜到的数据」再清元数据，避免留下「搜得到但文档没了」的幽灵）；
`POST /api/kb/retry` 把失败任务复位 `queued` 由 worker 续跑。

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
- `/api/chat` 使用 Token 预算上下文：system prompt、可选结构化摘要和最多 40 轮近期原文。
- 最近 8 条消息的 legacy 默认路径仍用于 Plan 的 ReAct 回退和部分评测脚本，不再代表普通聊天主路径。
- 模型 HTTP 调用内部是非流式的，外部仍通过 SSE 推送最终文本。
- 同类工具连续失败达到上限后会停止继续执行，并把失败原因回填给模型。
- `getWeather`、`getCurrentTime` 可直接执行。
- `draft_message` 必须先经过人工确认。

### 长上下文压缩

`/api/chat` 的上下文管理按以下顺序执行：

1. 估算消息 Token；CJK 字符按 1 Token、非 CJK 字符按 4 字符 1 Token 估算，并叠加消息开销。
2. 用 `LLM_CONTEXT_WINDOW_TOKENS × LLM_CONTEXT_BUDGET_RATIO` 计算预算，再夹到 `[1024, 窗口]`。
3. 比较预算时对估算值乘 `1.15` 安全系数，优先保留 system prompt、本轮用户消息和近期完整轮次。
4. 只保留工具调用与其结果的完整配对，避免供应商因孤立 `tool_calls` 或 `tool` 消息返回 400。
5. 当至少丢弃 2 条消息且被丢弃内容估算不少于 200 Token 时，才尝试生成结构化摘要。
6. 摘要失败时仍发送 `context_compacted`，但 `degraded=true`、`summary=null`，并回退到近期原文窗口继续聊天。

成功生成的摘要会由前端保存，并在后续请求的 `contextSummary` 中带回。服务端会忽略版本未知、
字段损坏或内容不合法的摘要，不会因此阻断聊天。

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
  "searchDocs": false,
  "contextSummary": null
}
```

`contextSummary` 可选。首轮传 `null` 或不传；服务端发生压缩后会通过
`context_compacted` 返回结构化摘要，客户端可在后续请求中带回，避免早期原文重复注入。
摘要版本未知、字段损坏或内容不合法时，服务端按“无摘要”处理并继续聊天。

### `POST /api/chat/multi`

多 Agent 聊天，响应类型为 `text/event-stream`。

请求体与 `/api/chat` 相同。`searchDocs: true` 会强制路由中包含 `kb` Worker。

### `POST /api/chat/plan`

Plan-and-Execute 聊天，响应类型为 `text/event-stream`。`mode` 可取 `auto`、`react` 或 `plan`；
省略时默认为 `auto`。简单任务可由规则分类器直接走 ReAct，复杂任务才进入 Planner。

请求体：

```json
{
  "messages": [
    { "role": "user", "content": "先查资料，再写一份部署方案对比" }
  ],
  "model": "deepseek-chat",
  "mode": "auto",
  "searchDocs": true
}
```

请求约束：

- `model` 必填，并且 `messages` 必须包含至少一条 `user` 消息。
- 消息角色只允许 `user` 和 `assistant`。
- 计划最多 6 步；每步最多 3 个工具，工具必须在白名单内并去重。
- 计划步骤 id 必须按 `step_1` 到 `step_6` 连续排列。
- 整任务共享默认 15 次模型调用预算；预算耗尽后停止继续规划或执行。
- 计划非法或规划失败时回退 ReAct；Re-plan 最多一次。
- 用户拒绝人工确认后，不会通过 Re-plan 绕过确认。
- 请求体非法时返回 HTTP 400 JSON，不会建立 SSE 流。

工具过程事件仍复用通用 SSE 形状。Plan 的 ReAct 回退分支保留 legacy 近期上下文策略。

### `POST /api/chat/structured`

Streaming 结构化输出，响应类型为 `text/event-stream`。当前只支持 `table` 和 `code` 两种目标，
浏览器只提交对话消息、模型名和目标类型。

请求体：

```json
{
  "messages": [
    { "role": "user", "content": "生成一个三行对比表" }
  ],
  "model": "deepseek-chat",
  "target": "table"
}
```

请求约束：

- `messages` 为 1 到 100 条，只允许 `user` 和 `assistant`，单条内容最多 20,000 字符。
- `model` 最多 120 字符；`target` 只能是 `table` 或 `code`。
- 请求对象和每个消息对象都是 strict Schema，不能携带额外字段；结果 `schemaVersion` 固定为 `1`。
- 表格最多 8 列、50 行；列名最多 120 字符，单元格最多 2,000 字符。
- 代码语言最多 32 字符，代码正文最多 20,000 字符。
- 请求体非法时返回 HTTP 400 JSON，不会建立 SSE 流。

服务端读取模型原生流，累积不完整 JSON，只把通过快照 Schema 的稳定结果作为
`structured_snapshot` 发送；完整结果还必须通过 `StructuredResultSchema` 才能进入完成态。
前端以 snapshot 作为增量渲染源，`structured_delta` 只报告接收进度，不暴露原始 JSON。

| 结构化错误码 | 含义 |
| --- | --- |
| `model_request_failed` | 上游模型请求失败 |
| `model_stream_interrupted` | 模型流在完成前中断 |
| `partial_parse_failed` | 中间 JSON 解析失败 |
| `invalid_final_json` | 最终内容不是合法 JSON |
| `schema_validation_failed` | 最终 JSON 未通过完整 Schema |
| `provider_json_mode_unsupported` | 供应商不支持请求的 JSON mode |

默认请求供应商 JSON mode。若供应商明确不支持，服务端会自动改用 prompt-only 重试一次；
可通过 `LLM_STRUCTURED_JSON_MODE=0` 直接关闭 JSON mode。

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
  "model": "deepseek-chat",
  "category": "学习计划"
}
```

`history` 只能包含 `user` 和 `assistant`。`category` 可选：传了 → 动态知识库只在该
分类内搜；不传/空 → 动态库全库搜（离线库不受影响）。system prompt 由服务端生成，
前端不能覆盖。

### 知识库管理接口

#### `POST /api/kb/upload`

上传一份 Markdown，只做「收件」，立即返回 `queued` 任务，切片与入库由后台
worker 推进。请求体 `{ filename, content(base64), category }`，限制 1MB、只收
`.md`、分类非空；文件名取 basename 防路径穿越。校验失败返回 400 + 可读文案。

#### `GET /api/kb/tasks`

返回全部任务（`createdAt` 倒序）+ 每篇文档的实时块数。块数不冗余在任务里，
由块表实时统计，避免状态字段过期。

#### `GET /api/kb/chunks`

按 `?docId=xxx` 返回该文档全部块（按 `seq` 排序），用于块预览。只读块表，
不触发切片、不触发向量化。

#### `GET /api/kb/categories`

返回全部分类（新分类在前），前端下拉框数据源。

#### `POST /api/kb/categories`

建分类，请求体 `{ name }`。名字去空白后不能为空，同名去重（重复建返回已有
分类记录），不产生「无名分类」脏数据。

#### `POST /api/kb/search`

按分类检索，请求体 `{ question, category, topK? }`。问句 embed 后在指定分类里
取 TopK（分类空则全库搜）；返回命中数组，前端直接渲染原文 + 分数。

#### `POST /api/kb/delete`

按 `docId` 删除一篇文档，四环事务：删向量 → 删块 → 删任务 → 删磁盘原件目录。
先清「可被搜到的数据」再清元数据，任一环失败都不会留下「搜得到但文档没了」的幽灵。

#### `POST /api/kb/retry`

重试一条失败任务，请求体 `{ id }`。把任务复位 `queued`，由后台循环重新拾起；
`docId` 不变，重试不会重复建文档。

### `POST /api/chat/confirm`

放行或拒绝待确认工具调用。成功返回 JSON，不负责执行工具。

确认会话不存在时返回 `404`。工具调用不存在、已处理或 `toolCallId` 错误时也返回 `404`。

### `GET /api/chat/confirm/:confirmId`

调试接口，列出指定确认会话当前挂起的工具调用。

### `POST /api/chat/reflection`

独立反思端点，响应类型为 `text/event-stream`。先出一版答案，再回头评分，必要时重写。

请求体：

```json
{
  "question": "为什么改了切分还要重新入库？",
  "sessionId": "session-1",
  "model": "deepseek-chat",
  "mode": "shadow",
  "searchDocs": false
}
```

请求约束：

- `question` 必填；`sessionId`、`model`、`searchDocs` 可选。
- `mode` 只能是 `shadow` 或 `enforce`，而且**只能把服务端模式往下调**（`enforce` → `shadow`），不能往上抬。最终生效的模式看服务端日志。
- 请求体非法时返回 HTTP 400 JSON，不会建立 SSE 流。
- 生成阶段失败时降级返回初版答案，不会把整个请求打挂。

这个端点**不在默认聊天链路里**，是实验能力。日常聊天不受 `REFLECTION_MODE` 影响。

### `GET /api/memory`

列出当前生效的记忆（已过滤过期与软删除，按最近更新排序）。必须带 `userId`：

```bash
GET /api/memory?userId=anon_xxxxxxxx
```

`userId` 必须形如 `anon_` 加 1～64 位字母数字下划线连字符，缺失或非法返回 400。

### `POST /api/memory`

手动写入一条记忆。同 key 同值合并；同 key 不同值**不自动覆盖**，旧记录被标上 `conflict`，由用户在面板里裁决。

```json
{
  "userId": "anon_xxxxxxxx",
  "key": "preferred_stack",
  "value": "Vue 3",
  "source": "manual",
  "confidence": 0.9
}
```

响应里 `fact` 是最终记录，顶层 `conflict` 布尔方便前端不用钻进 `fact` 里找。

### `PATCH /api/memory/:id`

修改一条记忆的 `value` / `confidence` / `expiresAt`。

- 传了不可改字段（`key`、`source`）直接返回 400 并说明原因，**不静默忽略**——静默忽略会让前端以为改成功了。
- 找不到记录和跨用户访问都返回 404，分不清「不存在」和「不是你的」，否则这条接口就成了探测别人记忆 id 的工具。

### `DELETE /api/memory/:id`

软删除一条记忆。记录仍保留在磁盘上，可审计。

### `DELETE /api/memory`

清空全部记忆，**必须显式带 `confirm=all`**，否则返回 400。清空对用户来说不可撤销，少一个确认键比多一个麻烦安全。

### `GET /api/usage`

返回按两个时间口径分开的统计：**全部** 和 **当天**（本地时区当天 00:00 起）。

两个口径字段完全一致：`totalRequests`、`totalPromptTokens`、`totalCompletionTokens`、
`totalTokens`、`totalCostUsd`，以及按 endpoint / model 分组的 `byEndpoint`、`byModel`。
其中「全部」在响应顶层，「当天」在 `today` 字段下，另外还返回最近 50 条原始记录 `recent`。

前端的 Token / 成本面板按这两个口径拆成「全部」「当天」两个独立模块展示。

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
| `context_compacted` | 单 Agent / 多 Agent 长上下文发生压缩，携带摘要和压缩前后 Token 估算 |

> `react/types.ts` 仍声明了 `searchDocs_result`，但当前实现没有发射这个事件；单 Agent prefetch 的结果通过通用 `tool_result` 展示。

Plan-and-Execute 额外事件：

| `type` | 主要字段 | 说明 |
| --- | --- | --- |
| `plan_route` | `mode`、`reasonCode`、`signals` | 规则路由结果与原因 |
| `plan_created` | `planId`、`revision`、`plan` | 计划已生成，第一步执行前可见 |
| `plan_step_started` | `stepId`、`index`、`total` | 当前步骤开始 |
| `plan_step_done` | `stepId`、`summary`、`toolsCalled` | 当前步骤完成 |
| `plan_step_failed` | `stepId`、`code`、`retryable` | 当前步骤或计划级失败 |
| `plan_replanned` | `previousRevision`、`revision`、`plan` | 受控 Re-plan 产生新计划 |
| `plan_fallback` | `reasonCode`、`message` | 计划不合法或规划失败，回退 ReAct |
| `plan_finished` | `status`、`completedSteps`、`totalSteps` | 计划终态 |

Streaming 结构化输出额外事件：

| `type` | 主要字段 | 说明 |
| --- | --- | --- |
| `structured_start` | `requestId`、`schemaVersion` | 进入结构化流 |
| `structured_delta` | `sequence`、`receivedChars` | 只报告接收进度，不驱动业务渲染 |
| `structured_snapshot` | `revision`、`snapshot` | 可安全展示的稳定中间态 |
| `structured_done` | `revision`、`result` | 最终对象已通过完整 Schema |
| `structured_error` | `code`、`retryable`、`lastRevision` | 可分类错误，并保留最后一个稳定快照 |

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
| `/api/chat/plan` | 分类、Planner、步骤执行、Re-plan 和最终回答 |
| `/api/chat/structured` | 一次结构化模型流；摘要用量不计入此端点 |
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

评测分三类，前置条件不同。

### Agent 评测

```bash
npm run eval:chat
npm run eval:chat -- --id time-now
npm run eval:multi
npm run eval:multi -- --id multi-weather-only
```

这组评测调用真实模型，需要可用的 `LLM_API_KEY`，并且 `MOCK_MODE` 不能为 `1`。

- `evals/dataset.json`
- `evals/dataset-multi.json`

### Plan 评测

```bash
npm run eval:plan
npm run eval:plan -- --id plan-order-steps
npm run eval:plan -- --verbose
npm run eval:plan -- --compare
```

Plan 评测默认完全离线：使用 `evals/dataset-plan.json`、预置 Mock 剧本和规则判分，
不请求真实模型，也不调用真实工具。`--id` 可筛选用例，`--verbose` 输出观测值；
只有 `--compare` 会调用真实模型，对 ReAct 与 Plan 的模型调用数、工具调用数、
首字延迟、总延迟、成功率和计划可见性做对比。

### 长上下文验收

```bash
npm run test:long-context
npm run test:long-context -- --mode=summary-broken
npm run test:long-context -- --mode=summary-ok --backend=real
```

默认 `--backend=stub`，会拦截模型请求并模拟摘要成功、摘要失败和不生成摘要三条路径。
它验证的是“裁剪 → 摘要 → 重新注入 → 继续回答”的链路，不代表真实模型质量。
使用 `--backend=real` 才会连接 `LLM_BASE_URL`，此时需要真实 Key。

常用参数：

- `--mode=no-summary|summary-ok|summary-broken`
- `--rounds=51`
- `--max-rounds=40`
- `--window-tokens=64000`
- `--budget-ratio=0.5`
- `--verbose`

评测会串行执行，真实模型单条请求可能需要数十秒。运行真实评测时建议关闭 LangSmith，
减少额度和跟踪噪声。

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
| `npm run eval:plan` | 运行 Plan 离线 Mock 评测；加 `--compare` 切到真实模型对比 |
| `npm run eval:judge` | 运行 LLM-as-Judge 离线评测管线 |
| `npm run judge:check` | 校验 Judge 评测数据集质量 |
| `npm run test:long-context` | 运行长上下文验收，默认 stub 后端 |
| `npm run test:memory` | 运行 Memory 端到端校验 |
| `npm run test:chains` | 运行五链路回归，确认记忆改造没波及既有链路 |

脚本的完整清单和每支脚本的用途见 `scripts/README.md`。

带参数调用 npm script 时必须使用 `--`：

```bash
npm run rag:search -- "不要把整篇文档塞进 prompt 冒充 RAG"
npm run rag:preview-prompt -- "今天北京适合出门吗？"
npm run eval:chat -- --id weather-gz
```

## 目录结构

```text
step1-chat/
├── src/                     前端：Vue 3 + TypeScript
│   ├── api/                 SSE 请求与事件解析、记忆 / 模型 / 用量客户端
│   ├── components/          聊天、工具轨迹、命中、用量、记忆、计划面板
│   ├── composables/         聊天状态中枢 useChat：发流、重试、事件归并
│   ├── rag/                 引用切分
│   └── vision/              图片压缩与快速校验
├── server/                  服务端
│   ├── routes/              Express 路由和 SSE 封装
│   ├── chat.ts              单轮对话内核：system、上下文、Guard、记忆、编排
│   ├── react/               单 Agent ReAct / LangGraph
│   ├── multi-agent/         Supervisor、Worker、Aggregate
│   ├── rag/                 RAG 检索、重排、Prompt 和回答
│   │   └── queryEnhance/    意图、扩写、路由、多路召回、HyDE
│   ├── kb/                  动态知识库：上传、切片、向量化、分类、检索、删除
│   ├── context/             Token 预算、上下文裁剪和结构化摘要
│   ├── memory/              跨会话长期记忆：数据模型、检索、抽取、公共接入层
│   ├── structured/          Structured 协议、partial 解析和流式快照
│   ├── plan-execute/        Plan 路由、Planner、Executor 和 Re-plan
│   ├── reflection/          自我评估：评分与重写
│   ├── guard/               输入、工具、输出防护 + LLM Judge
│   ├── answer-style/        知识库回答风格收敛
│   ├── vision/              图片校验、能力判定、协议转换
│   ├── tools/               工具 Schema 和本地实现
│   ├── mcp/                 MCP Server
│   ├── mock/                无 Key 时的假流式回复
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

每个子目录都有自己的 README，讲清那条链路的具体机制；
`server/README.md` 和 `src/README.md` 是两张总地图。

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

### 总地图

- `server/README.md`：服务端分层总览与模块地图
- `src/README.md`：前端分层总览、组件与状态中枢说明
- `scripts/README.md`：本地验证脚本清单与用法
- `evals/README.md`：评测数据集与两套判分体系

### 模块说明（每个目录一份）

- `server/routes/README.md`：HTTP 端点总表与两种响应风格
- `server/react/README.md`：单 Agent ReAct 循环与人工确认闸门
- `server/multi-agent/README.md`：Supervisor、Worker、Aggregate
- `server/plan-execute/README.md`：Planner、Executor 与 Re-plan
- `server/structured/README.md`：结构化输出的协议与状态机
- `server/reflection/README.md`：自我评估的评分与重写
- `server/guard/README.md`：输入、工具、输出三道防护
- `server/memory/README.md`：跨会话记忆的数据模型与链路
- `server/context/README.md`：Token 预算、上下文裁剪与摘要
- `server/rag/README.md`：检索、重排、拼 prompt 与生成
- `server/kb/README.md`：动态知识库的上传、状态机、分类、检索与 RAG 衔接
- `server/rag/queryEnhance/README.md`：检索前查询增强五个单元
- `server/answer-style/README.md`：知识库回答风格收敛
- `server/vision/README.md`：图片输入的服务端校验与协议转换
- `src/vision/README.md`：前端图片压缩与快速校验
- `server/tools/README.md`：工具注册表与本地实现
- `server/mcp/README.md`：MCP Server
- `server/mock/README.md`：无 Key 时的假流式回复
- `server/tracing/README.md`：LangSmith 追踪与 span 结构
- `server/usage/README.md`：Token 统计与成本估算

### 专题说明

- `docs/llm-judge.md`：输出判定（Judge）的三档模式、判定口径和运维说明
- `docs/reflection.md`：自我评估（Reflection）的三档模式、准入条件和降级策略
- `docs/vision.md`：图片输入（Vision）的模型能力判定、图片上限和当前边界
- `docs/memory.md`：跨会话记忆阶段总结（数据模型、事实 vs 语义选型、实测数据、隐私设计）
- `docs/memory-chain-integration.md`：记忆接入各链路的集成说明
- `docs/long-context.md`：长上下文预算、结构化摘要、降级和压缩提示
- `docs/project-messages-flow.md`：消息组装与调用链
- `docs/rag-query-enhance-notes.md`：RAG 查询增强
- `docs/dynamic-tool-discovery.md`：工具动态发现机制
- `docs/mcp-usage.md`：MCP 接入与使用说明
- `docs/resilience-failure-map.md`：失败与降级地图
- `docs/structured-output.md`：Streaming 结构化输出阶段总结
- `docs/plan-and-execute.md`：Plan-and-Execute 架构、事件、确认边界和验收状态

### 改造记录

- `docs/llm-judge-changelog.md`：输出判定设计记录
- `docs/reflection-changelog.md`：自我评估设计记录
- `docs/vision-changelog.md`：图片输入变更记录
- `docs/memory-changelog.md`：跨会话记忆变更记录
- `docs/memory-chain-changelog.md`：记忆链路变更记录
- `docs/human-confirm-changelog.md`：人工确认设计记录
- `docs/multi-agent-human-confirm-changelog.md`：多 Agent 确认流程
- `docs/rag-input-output-guard-changelog.md`：RAG 防护改造
- `docs/post-learning-optimization-changelog.md`：后学习优化记录

### 图表与流程

- `docs/flows-index.md`：流程索引
- `docs/flows-index.html`：浏览器版流程索引（纯静态，直接打开；一页看全部 SVG 泳道图）
- `docs/project-topology.html`：项目拓扑与模块总览（Mermaid 图 + 方法级调用链，需联网加载 Mermaid）
- `diagrams/index.html`：图表导航页
- `sequence-diagrams.md`：时序图与 Mermaid 源说明
- `docs/structured-output-flow.svg`、`docs/plan-and-execute-flow.svg`、
  `docs/long-context-flow.svg`、`docs/memory-flow.svg`：各链路全链路图

两个 HTML 页面怎么在浏览器 / IDE / Git 里预览，见 `docs/flows-index.md` 开头的「两个 HTML 页面」一节。

### 评测报告

- `evals/judge-comparison-report.md`：判定能力评测报告
- `evals/judge-comparison-report.smoke.md`：判定能力冒烟报告
- `evals/reflection-comparison-report.md`：自我评估评测报告
