# Step 1 · AI Chat

阶段 1“会说话的 UI”的项目骨架：Vue 3 + Vite + TypeScript 前端，Express 轻量 API 层，裸写 `fetch + ReadableStream` 完成流式对话，不依赖任何 AI/Agent 框架。

## 已实现

- 多轮对话与流式输出（SSE）
- 模型切换
- 中断、重新生成、清空会话
- localStorage 历史持久化
- Mock 模式：未配置 API Key 时也可完整演示

## 启动

```bash
cd step1-chat
cp .env.example .env
npm install
npm run dev
```

打开 http://localhost:5173。

## 接入真实模型

在 `.env` 中填入：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
```

`LLM_BASE_URL` 使用 OpenAI 兼容格式，DeepSeek、通义千问、OpenAI 均可。留空 `LLM_API_KEY` 或设置 `MOCK_MODE=1` 会进入 Mock 模式。

`.env.local` 会优先于 `.env`，适合你本地单机调试。

## 目录

```text
server/          Express API 层：SSE 流式代理
server/rag/      阶段 3 RAG 零件（切分 / 向量 / 库 / 检索 / 拼 prompt）
scripts/         RAG 学习用命令行脚本（不接聊天页）
src/api/         前端裸 fetch + ReadableStream 解析
src/composables/ 聊天状态、中断、重试、持久化
src/components/  UI 组件
```

## RAG 相关 npm 命令

阶段 3 按「单点验证」拆成多条命令：每条只练一个环节，通过后再往下串。  
这些脚本**不会**走 `/api/chat`。页面上切到「资料问答」后走独立接口 `POST /api/rag/chat`。

命名习惯：

| 前缀 | 含义 |
|---|---|
| `rag:preview-*` | 预览：打印中间结果，给人看 |
| `rag:test-*` | 验收：有固定断言，失败会 `exit 1` |
| `rag:ingest` / `rag:search` / `rag:ask` | 业务向脚本：入库、按问题检索、终端调模型（仍是 CLI） |

建议顺序（和零件依赖一致）：

```text
predawn:bge
  → rag:preview-chunks
  → rag:test-embed
  → rag:ingest
  → rag:test-store
  → rag:search / rag:test-retrieve / rag:test-empty
  → rag:preview-prompt / rag:test-prompt
  → rag:ask
  → predawn:rerank → rag:test-rerank
```

### 命令说明

| 命令 | 干什么 | 为啥要这么写 |
|---|---|---|
| `npm run predawn:bge` | 预下载本地 embedding 模型 `bge-large-zh-v1.5` 到 `models/` | 向量化依赖本地模型；先单独下载，避免第一次 `embed` 时卡住、也方便离线 |
| `npm run rag:preview-chunks` | 对示例 Markdown 跑切分，打印每块 id / 标题 / 预览 | **只验切分**：块大小、标题、overlap 对不对，还不碰向量和库 |
| `npm run rag:test-embed` | 对几句样例文本算向量，检查维度、同句相似度 | **只验 embedding**：模型能加载、`1024` 维、`normalize` 正常，再谈入库 |
| `npm run rag:ingest -- [md路径]` | 切分 → 向量化 → 写入 `.chroma/my_notes.json`（默认识别 `docs-sample/stage3-rag-notes.md`） | **建库入口**：同一 `source` 先删旧再写新；问答检索读的是这份 JSON，不是再读整篇 md |
| `npm run rag:test-store` | 对已落盘的库做读写 / 按 source 计数等检查 | **只验存储层**：文件在不在、结构能不能 load/search，和「切得好不好」分开 |
| `npm run rag:search -- "你的问题"` | 问题 → 检索 + 空结果判断 → 打印 TopK / empty / 分数 | **手工看召回**：先看 rawHits 有没有正确块，再看 empty 是不是闸门误杀；`empty` 不等于「没搜到」 |
| `npm run rag:test-retrieve` | 固定 3 类问题：直接命中、近义、资料外低分 | **检索验收**：该进 Top5 的块要进来；无关问题 Top1 不得虚高（≥ 0.6） |
| `npm run rag:test-empty` | 有资料 / 资料外各一条，检查 `empty` 与 `hits` 是否清空 | **只验判空闸门**：低分不能拿去注入；`rawHits` 仍保留方便调试 |
| `npm run rag:preview-prompt -- "你的问题"` | 检索 → `buildRagPrompt` → 打印将发给模型的 `messages` | **只看拼 prompt**：固定 system + 资料块 + 历史 + 当前问句；**不调 LLM** |
| `npm run rag:test-prompt` | 不依赖向量库，用假命中检查拼 prompt 规则 | **纯函数验收**：空结果不拼 messages；资料在 system、问句在 user、历史会裁剪 |
| `npm run rag:ask -- "你的问题"` | 检索 → 拼 prompt → 有命中才调聊天模型 | **第一次把资料交给 LLM**：空结果不调模型；不走 `/api/chat`，不带天气工具 |
| `npm run predawn:rerank` | 预下载交叉编码器 `bge-reranker-base` 到 `models/` | 重排和句向量是两套模型；问答有资料时才会加载 |
| `npm run rag:test-rerank` | 同一问句打印向量前 5 与重排后注入的 5 段 | **看顺序有没有变**：先多召回 20，再精排取 5 |

带参数时注意 `--`，否则参数会进 npm 而不是脚本，例如：

```bash
npm run rag:search -- "不要把整篇文档塞进 prompt 冒充 RAG"
npm run rag:preview-prompt -- "今天北京适合出门吗？"
npm run rag:ask -- "不要把整篇文档塞进 prompt 冒充 RAG"
npm run rag:ingest -- docs-sample/stage3-rag-notes.md
```

### 为啥不做成一条「一键 RAG」

- 切分错了却去调 embedding，会浪费时间且难定位  
- 入库成功 ≠ 检索合格；检索有命中 ≠ 可以注入（还要判空）  
- 判空看的是「能不能当资料」，不是「search 有没有行」。标题问句可能 Top1 正确但分数 &lt; 0.6，只看分数会被误杀（见 `retrieve.ts`）  
- 拼好 `messages` ≠ 已经接到聊天；`rag:ask` 是终端版，页面切到「资料问答」才走 `/api/rag/chat`（仍不走 `/api/chat`）  

所以 `package.json` 里拆成多条 `rag:*`：每条对应学习计划里的一个单点，失败时只重跑那一条。

## 页面上的资料问答

1. `npm run rag:ingest` 先把笔记入库  
2. `npm run dev` 打开页面  
3. 顶栏点成 **资料问答**（不要停在「普通对话」）  
4. 问入库文档里的问题；资料外的问题应直接说「资料里没有」，不调模型  
5. 输入框上方的 **检索命中** 面板会列出问句、TopK 分数、哪几段进了 prompt（`[n]`）  
6. 回答里的 `[1]` 可点，对上面板真实块；编号不在注入列表里会划掉，不当依据 

普通对话仍走 `/api/chat` + 天气工具；资料问答走 `POST /api/rag/chat`，两套历史分开存。
