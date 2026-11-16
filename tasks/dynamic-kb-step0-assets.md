# 动态知识库 · 步骤 0：资产盘点与复用边界

> 对应 `dynamic-kb-execution-plan.md` 步骤 0。目标项目：`step1-chat`。
> 结论一句话：**向量化与切片直接复用，检索与存储带分类重写，上传/任务/后台循环全部新建。**

## 1. 现有资产清单

### 可直接复用的内核（不改一行）

| 资产 | 位置 | 能力 | 复用方式 |
| --- | --- | --- | --- |
| 切分器 `chunkMarkdown` | `server/rag/chunker.ts` | 按标题×段落切片，带 `id/source/title/text/seq` | 动态知识库后台切块直接调用 |
| 向量化 `embed` | `server/rag/embedding.ts` | bge-large-zh-v1.5，1024 维，mean+normalize | 入库与提问共用这一套（计划铁律） |
| 余弦相似度 `cosine` | `server/rag/embedding.ts` | 检索打分 | 自己的检索逻辑直接 import |
| 预热 `warmEmbed` | `server/rag/embedding.ts` | 消首次检索冷启动 | 启动时复用 |

### 需要改造或重写的资产

| 资产 | 位置 | 为什么不能直接用 | 处置 |
| --- | --- | --- | --- |
| `LocalVectorStore` | `server/rag/vectorStore.ts` | 替换粒度是 `source`（文件名），没有「分类 + 文档 id」维度；文件固定在 `.chroma/my_notes.json` | **不直接复用**。新建动态知识库专用存储（JSON 文件 + 内嵌 cosine），记录 `category/docId/source` |
| `retrieve` / `retrieveForAnswer` | `server/rag/retrieve.ts` | 过滤维度是 `sources`（文件名集合），无分类硬边界；且自带全链路增强逻辑，超出学习范围 | **不直接复用**。按类检索自己写：`where category=?`，同一时刻只扫该类下 `searchable` 的块 |
| `answerFromDocs` | `server/rag/answer.ts` | 依赖增强/重排/合规等大链路 | 本计划暂不接 LLM 回答，检索层可用即可；后续接时只复用 `embed` |
| `scripts/ingest.ts` 等 CLI 脚本 | `scripts/` | 命令行喂路径的形态，缺任务状态机与分类 | 不当作成品，仅作参照 |

### 可直接继承的工程模式

- **JSON 持久化模式**：`server/memory/store.ts` —— 文件目录放 `data/`（已 gitignore），写入用「临时文件 + rename」，读坏降级为空。动态知识库的任务表/块表/向量文件沿用这套。
- **路由挂载方式**：`server/routes/index.ts` + 各 `register*Routes(app)` 文件，新路由照此注册。
- **路由实现风格**：`server/routes/ragChat.ts` —— 参数校验、明确错误码、不吞异常。

## 2. 必须新建的部分（后续步骤逐个落地）

| 模块 | 说明 | 对应步骤 |
| --- | --- | --- |
| 任务状态机 + 任务表 | `queued → chunking → embedding → searchable | failed`，失败记 `stage` | 1 |
| 上传接口 | 落盘原件 + 建任务，验收前不切片不 embed | 2 |
| 后台任务循环 | 轮询任务表推进状态 | 3 |
| 切块 + 块预览接口 | 复用 `chunkMarkdown`，块表先落库 | 4 |
| 异步入库 + 按文档替换 | 复用 `embed`，先清该「分类+文档」旧块再写新块 | 5 |
| 分类存储与按类检索 | `categories` 表 + 检索层 `category` 过滤 | 6 |
| 删除 / 重试 / 列表接口 | 连原型带向量一起清；失败从该层续跑 | 7 |
| 前端页面 | 分类选择 + 上传 + 任务列表 + 块预览 + 按类提问 | 8 |

## 3. 上传方式决策（记录在案）

现有依赖里**没有 multer**，`package.json` 依赖只有 express + 若干模型库。
为避免给项目新增网络安装依赖，动态知识库上传采用 **JSON + base64**：
前端 `FileReader` 读文件 → `POST /api/kb/upload`（`{ category, filename, content(base64) }`）→
服务端解码落盘。控制 1MB 上限，类型只收 `.md`。
这满足「文件从浏览器进服务器，留下原件和任务记录」，且链路学到的东西不变。

## 4. 本步骤验收（已满足）

- [x] 画得出两条链路：`上传→任务→切片→入库` 与 `提问→只读库`，入口分开
- [x] 一句话说清归属：**分类决定搜哪里（检索边界），文档 id 决定替换哪一批块**
- [x] 明确复用边界：切片/向量直接用，检索/存储带分类重写，上传/任务/后台新建
