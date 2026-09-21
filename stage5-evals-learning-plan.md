# 阶段 5 · 第三课：Evals（评测）

> 当前只写阶段 5 的**第三个知识点**，不展开 Token 成本、Prompt Injection、多 Agent、部署。  
> 这课接在 Tracing 后面最顺：你已经能看见一次请求怎么跑，下一步是**用固定问句自动判断「这次改动有没有把旧行为搞坏」**。

载体：`step1-chat` 的 `/api/chat`。`/api/rag/chat` 本课先不并进同一套 eval。

---

## 1. 介绍基础知识点

Evals 可以先理解成：**给 Agent 准备一套不会变的考题，改代码之后自动判分**。

Tracing 回答的是「这一次发生了什么」。  
Evals 回答的是「这一类问题现在还对不对」。

| 方式 | 回答什么 | 局限 |
|------|----------|------|
| 手动点聊天页 | 这一句看起来像不像 | 问句不固定、记不住上次标准、改完容易漏回归 |
| Tracing / LangSmith | 这一次调了谁、卡在哪、花了多久 | 不自动告诉你「该不该调」 |
| **Evals** | 固定问句集合上，行为是否仍符合预期 | 要先想清楚「什么叫对」 |

一句话：

- **Tracing** = 飞行记录仪（单次排错）
- **Evals** = 回归考卷（改完再跑一遍，看有没有退步）

你这几周已经踩过的，正好都是 Evals 该拦住的：

- 勾选「搜索知识库」但模型没走检索
- 为了强制检索，误把 `searchDocs` 从 tools 里拿掉
- 检索结果塞进 assistant 消息，下一轮取消勾选后胡编来源
- DeepSeek 思考模式缺 `reasoning_content` 导致 400

这些如果只靠「我记得要手动试一下」，下次加课还会再踩。

### 核心概念（先记这五个）

1. **Example（一条考题）**  
   固定输入 + 你关心的期望。例如：
   - 输入：`现在几点`，`searchDocs: false`
   - 期望：轨迹里出现 `getCurrentTime`，且最终有文字回复

2. **Dataset（考卷）**  
   多条 Example 放在一起。本课先用本地 JSON，不必一上来上 LangSmith Dataset。

3. **Run（一次作答）**  
   用当前代码跑这一条 Example，得到：最终文字、工具轨迹、是否报错。  
   本课跑的是现有 ReAct 链路，**不要为了 eval 另写一套假 Agent**。

4. **Evaluator（判分器）**  
   看 Run 是否符合期望。本课先用**规则判分**，不用「再叫一个大模型当老师」。

5. **Score / Pass（分数 / 是否通过）**  
   一条 Example 可以有多个检查项，例如：
   - 调没调对工具
   - 有没有编造来源
   - 有没有把整次请求打崩

### 三种常见评测（本课只用前两种）

| 类型 | 看什么 | 本课例子 |
|------|--------|----------|
| **Trajectory（轨迹）** | 调了哪些工具、顺序是否合理 | 「现在几点」必须出现 `getCurrentTime` |
| **Output（输出）** | 最终文字有没有越界 | 未勾选知识库时，不得声称刚检索了资料、不得编章节号 |
| LLM-as-judge（后置） | 用另一个模型打「是否忠实于资料」 | 本课先不做 |

### 和你项目的对应关系

```
evals/dataset.json          ← 考卷（固定问句 + 期望）
        │
        ▼
scripts/run-evals.ts        ← 逐条调用现有 chat / ReAct（不要另写假循环）
        │
        ├─ 最终文字
        ├─ 工具轨迹（可复用 onTrace / prefetch 的 searchDocs）
        └─ 是否抛错（如 400）
        │
        ▼
evaluators/*.ts             ← 规则判分：轨迹、输出、开关隔离
        │
        ▼
控制台报告（本课交付）
LangSmith Dataset（可选，有 Tracing 再挂）
```

页面 `ToolTracePanel`、LangSmith trace、Evals 三件事不要混：

| | ToolTracePanel | Tracing | Evals |
|--|----------------|---------|-------|
| 谁看 | 用户 / 演示 | 开发者排错 | 开发者回归 |
| 何时 | 当前一句 | 每次请求可查 | 改代码后批量跑 |
| 输出 | 调了谁 | span 树 | pass / fail 清单 |

---

## 2. 为啥要学习这个东西

阶段 4 你会让 Agent 做事，Tracing 你会看见它怎么做事。接下来高频问题变成：

- 我改了 system / prefetch / 工具列表，天气和时间还灵吗？
- 勾选知识库这一轮必检索，取消勾选下一轮还会不会编文档名？
- 这次「修搜索」有没有把思考模式 400 又带回来？

不学 Evals，你会停留在：

- 每加一课就靠感觉点几句聊天
- 刚建立起来的 ReAct 理解，被下一课的小改动冲掉还不知道
- 出了胡言乱语只能事后截图争论

学了 Evals，你可以：

- 用同一份考卷对比改前 / 改后
- 失败时带着 Example id 去 LangSmith 打开对应 trace
- 把「搜索知识库开关」这种易混逻辑写成**可重复的断言**，而不是口头约定

---

## 3. 学习这个能干些啥

学完这一课，你至少能做这几件事：

1. **写一份针对 `step1-chat` 的小数据集**  
   覆盖：纯聊天、时间、天气、天气+时间、勾选知识库、不勾选知识库、开关切换。

2. **用现有服务端路径跑评测**  
   调用 `createChatStream` / `runConversation` 同类入口，收集文字和工具轨迹。  
   禁止为了「好测」再抄一套 for 循环。

3. **用规则判分，不靠印象**  
   例如：未勾选时最终回复不得出现「根据知识库」「【本轮知识库检索」这类本轮检索口吻。

4. **把你踩过的 Bug 变成回归题**  
   至少包括：勾选必检索、取消勾选不得编来源、思考模式下一轮不 400。

5. **（可选）把同一份 dataset 同步到 LangSmith**  
   失败条目能点进 trace。没有这一步也可以先过关。

---

## 4. 这个难点在哪

难点不在「写个脚本 for 循环调 API」，而在**把模糊的「回答乱了」写成可判定的期望**。

### 五个常见坑

1. **用 LLM 打分当第一课**  
   老师模型自己也会漂。本课先规则：工具名、是否报错、是否出现禁用口吻、是否出现 prefetch 的 `searchDocs` trace。

2. **把「答案原文」写成死标准**  
   「现在几点」的回复每次都会变，不要断言整句相等。  
   断言轨迹和约束，不要断言文采。

3. **为 eval 改业务逻辑**  
   评测适配代码，不要反过来让 `runConversation` 为了分数走捷径。  
   尤其不要再给模型另一套 system。

4. **和 RAG 模式混卷**  
   `/api/chat` + 「搜索知识库」是一条路；`/api/rag/chat` 是另一条。  
   本课数据集只测前者。资料问答 eval 后置。

5. **开关题只测「开着」不测「关上」**  
   你已经证实：取消勾选后的下一句才会胡编。  
   数据集里必须有**同一段历史、下一轮 `searchDocs: false`** 的 Example。

### 和你前面经验的连接

| 你踩过的坑 | Eval 里应写成什么期望 |
|------------|----------------------|
| 勾选了但不走资料库 | `searchDocs: true` 时轨迹必须有 `searchDocs`（prefetch 的 onTrace 也算） |
| 把 `searchDocs` 从 tools 拿掉 | 勾选时 `requestCompletion` 的 tools 仍含 `searchDocs`（可用单测 / eval 辅助断言，不要只看最终文字） |
| 取消勾选后编章节 | 历史里有过知识库回答，本轮 `searchDocs: false` → 不得新编 `stageX-*.md` 章节号或「本轮已检索」 |
| 思考模式 400 | 含工具的多轮问句（天气+时间）不得以 `reasoning_content` 400 失败 |
| 火星天气误调工具 | 不得出现 `getWeather` |

---

## 5. 对工作、薪水有啥影响 / 提升的地方

Evals 是把 Agent 从 Demo 推进到「能改、敢改」的关键能力。

### 对工作内容的提升

- 从「我觉得没坏」→「这 12 条回归全绿」
- Prompt / 工具 / 检索策略的改动可以对比分数，而不是靠争论
- 和产品、QA 对齐时有共同语言：dataset、pass rate、bad case

### 常见岗位场景

- 改了知识库策略，要证明普通工具调用没回归
- 上新模型（例如换 `deepseek-v4-flash`）先跑 eval 再决定切不切
- 线上 Bad Case 沉淀回数据集，防止以后再犯

### 对薪水的间接影响

Evals 出现在 AI 应用 / Agent 工程师 JD 里的频率很高。  
会和不会的差别：你是「能做出能聊的页面」，还是「能维护行为不漂的 Agent」。

---

## 6. 学习顺序与验收

### 建议顺序（都在 `step1-chat` 里做）

**第一部分：建立概念（不写代码）**

- 对照本文画出：Example → Run → Evaluator → 报告
- 打开现有 `ToolTracePanel` 和 LangSmith，说清它们**不能**替代 eval
- 先手写 8～12 条考题草稿（问句 + `searchDocs` 开关 + 期望），不要一上来追求 50 条

**第二部分：本地 dataset（最小可用）**

建议文件：`step1-chat/evals/dataset.json`（路径可在动手时再定，但考题集合必须独立成文件）。

每条至少包含：

- `id`
- `messages`（可带上一轮历史，专门测开关切换）
- `searchDocs`（true / false）
- `expect.tools`（必须出现 / 不得出现）
- `expect.mustNotMatch`（输出禁则，如编造来源）
- `expect.ok`（不得抛错）

本课必收题型（缺一不算过）：

| id 思路 | 输入要点 | 期望 |
|---------|----------|------|
| time | `现在几点`，关知识库 | 有 `getCurrentTime`，无 `searchDocs` |
| weather | `广州的天气`，关知识库 | 有 `getWeather` |
| weather+time | `广州天气，顺便查查几点` | 两个工具都有 |
| mars | 火星温度类 | 无 `getWeather` |
| kb-on | 问笔记相关，开知识库 | 轨迹有 `searchDocs`；不把「没检索」当成功 |
| kb-off | 同上问句，关知识库 | 无 `searchDocs`；不得声称本轮检索 |
| kb-toggle | 历史上轮开过知识库并引用过资料，本轮关掉 | 不得新编文档名/章节；不得说「刚检索了」 |
| no-crash | 多步工具 | HTTP/LLM 不得 400 |

**第三部分：跑评测的脚本**

- `tsx` 脚本逐条跑，打印 pass/fail
- 失败时打印：id、期望、实际工具列表、最终文字摘要、错误信息
- 只做验证性运行，**禁止** `npm run build` / 生产构建
- 评测时可以关 LangSmith（`LANGCHAIN_TRACING_V2=false`），避免刷额度；失败后再单独开 Tracing 复盘

**第四部分：规则 Evaluator**

先实现这三个就够：

1. `toolsInclude` / `toolsExclude`：轨迹里的工具名
2. `outputForbidden`：最终文字命中禁用正则则 fail
3. `noThrow`：请求过程抛错则 fail

先不要做「语义是否正确」「文笔好不好」。

**第五部分：对照 Tracing（可选）**

- 同一条失败 Example 去 LangSmith 打开对应 `chat-request`
- 看是模型没出 `tool_calls`、prefetch 没跑，还是思考模式 400
- 这一步证明 Evals 和 Tracing 是配合关系：eval 找退步，trace 解释退步

### 怎么算「这一课过了」

- [ ] 能说清 Example / Dataset / Run / Evaluator，不和 Tracing、ToolTracePanel 混为一谈
- [ ] 有一份本地数据集，覆盖时间、天气、知识库开、知识库关、**开关切换**
- [ ] 一条命令能跑完全部 Example，得到 pass/fail（不必接 CI）
- [ ] 故意把「搜索知识库」关掉再问资料题，对应 Example 能红
- [ ] 不把 `/api/rag/chat`、LLM-as-judge、Token 成本页塞进本课交付

### 本课先不要混

- 不要一上来接 LangSmith 托管评测当唯一方案（概念可看，实现以后端脚本为准）
- 不要用另一个 LLM 给回答打 1～5 分（后置）
- 不要为了分数去改 ReAct 主循环、伪造 tool_calls
- 不要把资料问答 `/api/rag/chat` 和聊天开关揉进同一张卷
- 不要上 CI、告警、生产采样（知道「以后可以接」即可）

---

## 7. 和其他文档的关系

| 文档 | 关系 |
|------|------|
| `stage5-tracing-learning-plan.md` | 上一课（已完成）：单次请求可见 |
| `stage5-tracing-hands-on.md` | Tracing 动手（已完成） |
| **`stage5-evals-learning-plan.md`** | 本课概念与验收 |
| **`stage5-evals-hands-on.md`** | 本课动手：dataset + 脚本 + 规则判分 |
| `stage4-kb-search-tool-learning-plan.md` | 知识库开关的行为基线；eval 必须锁住「开/关/切换」 |
| Token / 成本页 | 再后几课，**后置**到部署前后；Evals 课不测 token |

---

## 8. 下一步

动手步骤见 **`stage5-evals-hands-on.md`**。

验收通过后，阶段 5 下一课是 **错误恢复与降级策略**。  
**Token 统计与成本控制** 后置到部署/成本页前后再学（见 `learning-plan.md` 阶段 5 顺序说明）。
