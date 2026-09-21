# 阶段 5 · 第二课：Tracing（可观测性）

> 当前只写阶段 5 的**第二个知识点**，不展开 Evals、Token 成本、Prompt Injection、多 Agent、部署。  
> 这课接在 MCP 后面最顺：工具边界已经清楚，下一步是**把 ReAct / RAG 整条链路录下来**，方便排错和给后面的 Evals 打基础。

## 1. 介绍基础知识点

Tracing 可以先理解成：**给 Agent 跑过的每一步留一份「飞行记录仪」**。

你现在已经有两种「看见过程」的方式：

| 方式 | 谁在看 | 能看到什么 | 局限 |
|------|--------|------------|------|
| 终端 `console.log` | 开发者本机 | 模型返回 JSON、回填 messages | 难检索、难对比多次请求、上线后看不到 |
| 页面 `ToolTracePanel` | 最终用户 / 演示 | 调了哪个工具、参数、结果 | 只有**当前这一句**；看不到模型第几轮、耗时、RAG 检索细节 |
| **Tracing** | 开发者 / 团队 | 整次请求的 span 树：LLM、工具、检索、错误、耗时 | 需要接 SDK 或平台 |

一句话：

- **ToolTracePanel** = 给用户演示「Agent 确实调了工具」
- **Tracing** = 给开发者查「为什么没调工具 / 哪一步慢 / 哪一步 400」

### 核心概念（先记这四个）

1. **Trace（追踪）**  
   一次完整用户请求，例如问一句「广州天气，顺便查查几点」。

2. **Span（片段）**  
   Trace 里的一小段工作，例如：
   - `askModel` 第 1 轮
   - `getWeather` 执行
   - `askModel` 第 2 轮
   - `retrieveForAnswer`（资料问答或 `searchDocs`）

3. **父子关系**  
   一个 Trace 下有多层 Span：  
   `POST /api/chat` → `runConversation` → `askModel(turn=1)` → `getWeather`

4. **属性（attributes）**  
   挂在 Span 上的元数据：模型名、`turn`、工具名、是否 `isError`、耗时 ms。  
   后面 Evals 和成本统计都靠这些字段。

### 和你项目的对应关系

```
用户发消息
  └─ trace: chat-request
       └─ span: runConversation (LangGraph)
            ├─ span: askModel turn=1     ← requestCompletion
            ├─ span: applyTools          ← applyToolCalls
            │    └─ span: getWeather
            ├─ span: askModel turn=2
            └─ span: reply
```

资料问答 `/api/rag/chat` 是**另一条 trace**，不要和 `/api/chat` 混在同一张图里硬塞。

### 常见平台（二选一入门即可）

| 平台 | 特点 | 和你项目的关系 |
|------|------|----------------|
| **LangSmith** | LangChain 官方，和 LangGraph 集成顺 | 你已在用 `@langchain/langgraph`，回调接入成本低 |
| **Phoenix（Arize）** | 开源、可自托管 | 适合不想上云、想本地看 trace 的场景 |

**本课建议首选 LangSmith**：和现有 LangGraph 栈一致；Phoenix 可作为「对比阅读」，第二课后半或复习时再碰。

---

## 2. 为啥要学习这个东西

阶段 4 你已经会 ReAct，MCP 你也把工具独立出去了。接下来高频问题是：

- 「现在几点」为什么没调 `getCurrentTime`？是模型没出 `tool_calls`，还是思考模式 400？
- 「广州天气 + 时间」为什么调了两次、分别花了多久？
- `searchDocs` 慢，是 embedding、向量检索还是 rerank 卡住了？
- 改了一版 system prompt，整体行为变好了还是变差了？**光靠肉眼看页面答不出来**

不学 Tracing，你会停留在：

- 靠 `console.log` 肉眼 grep
- 每次改 prompt 都要手动点一遍聊天页
- 线上出问题没有历史记录

学了 Tracing，你可以：

- 打开一条 trace，从根到叶子看清完整路径
- 对比两次请求的 span 差异（调了 / 没调工具）
- 为下一课 **Evals** 提供「什么叫通过、什么叫失败」的证据

---

## 3. 学习这个能干些啥

学完这一课，你至少能做这几件事：

1. **给 `/api/chat` 的 ReAct 循环挂 trace**  
   每一轮 `askModel`、每一次 `applyToolCalls` 在 LangSmith 里能看见。

2. **区分「用户面板」和「开发 trace」**  
   `ToolTracePanel` 继续给用户看；LangSmith 给排错用，职责不混。

3. **定位你踩过的真实问题**  
   例如 DeepSeek 思考模式 `reasoning_content` 缺失导致的 400，在 trace 里能看到是**第几轮 LLM** 失败。

4. **给 RAG / searchDocs 单独加 span（可选）**  
   `retrieveForAnswer` 内部分段：embed → search → rerank，知道慢在哪。

5. **为 Evals 铺路**  
   固定测试问句跑完后，不用截图，直接在平台里批量看 trace 是否出现 `getCurrentTime` 等 span。

---

## 4. 这个难点在哪

难点不在「装一个 SDK」，而在** span 划分的边界**。

### 四个常见坑

1. **和 ToolTracePanel 重复造轮子**  
   不要在页面上再做一个「开发版 trace 树」。  
   页面保持简洁；详细 span 走 LangSmith。

2. **一条用户消息 trace 里混入太多无关东西**  
   不要把 localStorage、前端渲染也写进服务端 trace。  
   服务端 trace 从 `/api/chat` 或 `/api/rag/chat` 入口开始即可。

3. **LangGraph 和手写的 span 打架**  
   优先用 LangGraph / LangChain 自带的 callback 挂到 `askModel`；  
   工具执行在 `applyToolCalls` 补 child span，避免同一轮打两次重复节点。

4. **敏感信息进 trace**  
   API Key、完整 `.env`、用户隐私不要写进 span attributes。  
   工具参数可以记「城市名、问句摘要」，知识库 hit 记 id/score，不必把整篇 chunk 原文塞满 trace。

### 和你前面经验的连接

| 你踩过的坑 | Tracing 里应看到什么 |
|------------|---------------------|
| 模型不调时间工具 | turn=1 的 LLM span 无 `tool_calls`，直接 `reply` |
| 思考模式 400 | turn=2 的 LLM span 标记 error + 400 消息 |
| 火星天气 `{ error }` | `getWeather` span：`isError=true` |
| searchDocs 很慢 | `retrieveForAnswer` 子 span 耗时分布 |

---

## 5. 对工作、薪水有啥影响 / 提升的地方

Tracing 是 **AI 应用工程化** 的标配能力，不是「锦上添花」。

### 对工作内容的提升

- 从「我能做一个能跑的 Demo」→「出了问题我能定位、能复现、能对比版本」
- 团队里排错不再只靠「你帮我看看 log」
- 和运维、后端、QA 沟通时有统一语言：trace id、span、latency

### 常见岗位场景

- Agent 行为不符合预期，产品问「卡在哪一步」
- 上线前压测：P95 延迟是在 LLM 还是在检索
- 接 Evals：自动跑 50 条问句，失败的在 trace 里点开看

### 对薪水的间接影响

Tracing 本身不单独标价，但它是 **AI 应用工程师 / Agent 工程师** 岗位 JD 里常出现的词。  
会和不会，差别在于：你是「写 Demo 的人」还是「能维护线上 Agent 的人」。

---

## 6. 学习顺序与验收

### LangSmith 注册与注意事项

动手前先完成账号和 API Key，否则后面环境变量配了也看不到 trace。

**链接**

| 用途 | 地址 |
|------|------|
| 注册 | [https://smith.langchain.com/signup](https://smith.langchain.com/signup) |
| 登录 / 首页 | [https://smith.langchain.com](https://smith.langchain.com) |
| 文档 | [https://docs.langchain.com/langsmith](https://docs.langchain.com/langsmith) |
| API Keys（注册后） | [https://smith.langchain.com/settings](https://smith.langchain.com/settings) → **API Keys** → **Create API Key** |

**注册时注意**

1. **先选数据区域（US / EU / APAC）**  
   注册第一步就要选，**选完不能改**。个人学习一般用 **US**（默认 `smith.langchain.com`）即可。  
   若选 EU / APAC，后续登录和 API 端点会不同（如 `eu.smith.langchain.com`），环境变量里的 endpoint 也要对应，别和 US 混用。

2. **登录方式**  
   支持 **Google、GitHub、Discord、邮箱**。用 GitHub 最省事，和本地开发习惯也一致。

3. **API Key 只显示一次**  
   在 Settings 里创建 Key 后立刻复制保存，写到 `.env.local`（不要提交 git）。  
   后面 Tracing 用：`LANGCHAIN_API_KEY=lsv2_...`

4. **Project 名字自己定**  
   建议建一个专用项目，例如 `step1-chat-dev`，对应环境变量：  
   `LANGCHAIN_PROJECT=step1-chat-dev`

5. **费用**  
   个人开发通常有**免费额度**，一般**不需要绑信用卡**。具体限额以 LangSmith 当前政策为准，学习阶段够用。

6. **Key 别进仓库、别贴聊天**  
   和 `LLM_API_KEY` 一样：只放 `.env.local`（项目里 `*.local` 已在 `.gitignore`）。  
   **不要把 Key 发给 AI、同事或截图**；若已泄露，立刻到 Settings 里 **Revoke** 旧 Key 并新建。

7. **区域与合规（了解即可）**  
   若以后接公司数据，要确认团队规定用哪个 region；本课个人 demo 用 US 即可。

**Workspace 和 Project 不要混（常见误解）**

你在 API Keys 表格里看到的 **Workspace 1**，是「这个 Key 属于哪个工作区」——由 **API Key 自动决定**，不用写进环境变量。

**`LANGCHAIN_PROJECT`** 是工作区**里面**的 trace 分组名（类似文件夹标签），**不必**叫 `Workspace 1`。

| 概念 | 是什么 | 要不要配环境变量 |
|------|--------|------------------|
| **Workspace** | 账号下的工作区（你的是 `Workspace 1`） | 不用；Key 已绑定 |
| **Project** | 同一工作区里 trace 的分组 | `LANGCHAIN_PROJECT=step1-chat-dev` |

所以：

- ✅ `LANGCHAIN_API_KEY` = 你的 Key → 自动进 `Workspace 1`
- ✅ `LANGCHAIN_PROJECT=step1-chat-dev` → 在左侧 **Projects** 里出现/筛选这个名（不存在会自动创建）
- ❌ 不要把 `LANGCHAIN_PROJECT` 设成 `Workspace 1`

注册 + 拿到 API Key 后，再往下做「建立概念」和代码接入。

### 建议顺序（都在 `step1-chat` 里做）

**第一部分：建立概念（不写代码）**

- 按上一节完成 LangSmith 注册，创建 Project（如 `step1-chat-dev`）
- 在 LangSmith UI 里随便点开一条官方示例 trace，认 span 树长什么样
- 对照 `runConversation.ts`：自己画出 askModel → applyTools → askModel 的 span 树

**第二部分：最小接入（只接 `/api/chat`）**

- 在 `.env.local` 配置（Key 从 Settings 复制，勿提交 git）：

  ```env
  LANGCHAIN_TRACING_V2=true
  LANGCHAIN_API_KEY=lsv2_你的Key
  LANGCHAIN_PROJECT=step1-chat-dev
  ```

- 在 LangGraph `invoke` 或 `requestCompletion` 传入 LangChain callbacks
- 验收：问「现在几点」，LangSmith 对应 Project 里能看到 LLM span + `getCurrentTime` 相关记录

**第三部分：补工具 span（可选但推荐）**

- 在 `applyToolCalls` 为每个工具加 child span：`name`、`duration`、`isError`
- 验收：问「广州天气，顺便查查几点」，trace 里两次工具调用顺序清晰

**第四部分：RAG 链路（可选）**

- 给 `/api/rag/chat` 或 `searchDocs` 的 `retrieveForAnswer` 加独立 trace 名
- 验收：资料问答一句，能看到检索相关 span，不与普通 chat trace 混淆

### 怎么算「这一课过了」

- [ ] 能在 LangSmith 找到任意一次 `/api/chat` 的完整 trace
- [ ] 能指出「第几轮 askModel、调了哪些工具、哪一步报错」
- [ ] 能说清 ToolTracePanel 和 Tracing 的分工，不重复做 UI
- [ ] （可选）RAG / searchDocs 有独立 span 或独立 trace 名

### 本课先不要混

- 不要同时上 Evals（那是第三课）
- 不要先做 Token 成本页（Tracing 里会顺带看到 token，够用了）
- 不要把聊天页改成「内嵌 LangSmith iframe」
- 不要上生产级采样、告警、SLO（知道概念即可，后置）

---

## 7. 和其他文档的关系

| 文档 | 关系 |
|------|------|
| `stage5-mcp-learning-plan.md` | 上一课（已完成） |
| `stage5-mcp-hands-on.md` | MCP 动手（已完成） |
| `stage4-react-process-learning-plan.md` | 用户向过程面板 + ReAct 图结构（已完成，和本课互补） |
| **`stage5-tracing-hands-on.md`** | 本课动手：接入 LangSmith 的步骤与验收 |
| `stage5-evals-learning-plan.md` | 下一课（Evals） |

---

## 8. 下一步

动手步骤见 **`stage5-tracing-hands-on.md`**（代码已接入 `server/tracing/langsmith.ts`）。

验收通过后进入 **Evals** 第三课（`stage5-evals-learning-plan.md`）。
