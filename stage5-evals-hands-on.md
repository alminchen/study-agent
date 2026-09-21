# 阶段 5 · 第三课 · Evals 动手计划

> 接 `stage5-evals-learning-plan.md`。在 `step1-chat` 里用**固定问句 + 规则判分**做回归，不改聊天页 UI，不另写一套 Agent。

## 0. 前置

- Tracing 课已过：能在 LangSmith 里看 `chat-request` → `askModel` → `tool`
- 评测时建议先关掉上报，少刷额度：

```env
LANGCHAIN_TRACING_V2=false
```

失败需要复盘时再打开 Tracing，用同一问句对着 trace 看。

## 1. 要交付什么（先记边界）

| 做 | 不做 |
|----|------|
| 本地 `evals/dataset.json` | 不要 LLM-as-judge |
| `tsx` 跑评测的脚本 | 不要 `npm run build` |
| 规则：工具轨迹 / 禁用口吻 / 不得抛错 | 不要改 `runConversation` 来「配合考试」 |
| 覆盖知识库开、关、**切换** | 不要把 `/api/rag/chat` 塞进这张卷 |

建议目录（动手时按此落地，文件名可微调）：

```
step1-chat/
  evals/
    dataset.json
    types.ts
    evaluators.ts
  scripts/
    run-evals.ts
```

`package.json` 加一条脚本即可，例如 `eval:chat`。

## 2. Dataset 最小字段

```json
{
  "id": "kb-toggle-off",
  "messages": [
    { "role": "user", "content": "不要把整篇文档塞进 prompt 冒充 RAG" },
    { "role": "assistant", "content": "根据资料 [1]，《stage3-rag-notes.md》第 10 节……" },
    { "role": "user", "content": "不要把整篇文档塞进 prompt 冒充 RAG" }
  ],
  "searchDocs": false,
  "expect": {
    "toolsInclude": [],
    "toolsExclude": ["searchDocs"],
    "mustNotMatch": ["本轮已检索", "stage3-rag-notes.md", "第 10 节"],
    "mustSucceed": true
  }
}
```

说明：

- `messages` 最后一条是本轮用户问句
- 开关切换题**必须带历史**：上一轮像查过资料，本轮 `searchDocs: false`
- 不要把「整段标准答案」写进 expect

## 3. 必收 Example（动手时逐条落地）

1. `time-now`：`现在几点`，关知识库 → include `getCurrentTime`，exclude `searchDocs`
2. `weather-gz`：`广州的天气`，关知识库 → include `getWeather`
3. `weather-and-time`：`广州天气，顺便查查几点` → 两个工具都有（显式并列问法）
4. `weather-time-one-sentence`：`广州当前时间的天气?` → 同一意图，**单句合成**，仍要两个工具
5. `mars-temp`：火星温度 → exclude `getWeather`
6. `kb-on-notes`：问切分 / RAG 笔记类，开知识库 → include `searchDocs`
7. `kb-off-same-q`：同一问句，关知识库 → exclude `searchDocs`，禁止「根据知识库 / 本轮检索」
8. `kb-toggle-off`：见上一节，专门锁你踩过的胡言乱语
9. `no-400-tools`：多步工具问句不得出现思考模式 400

天气/时间类若本地模型偶尔漏 `tool_calls`，先把失败记下来，**不要**为了绿而改 system 逼模型。本课目标是测现网行为，不是把分数刷满。

## 4. Runner 怎么接现网

脚本里应对齐页面：`searchDocs` 原样传给 `createChatStream`（或与之等价的服务端入口）。

收集：

- `onDelta` 拼出的最终文字
- `onTrace` 里的工具名（含 prefetch 的 `searchDocs`）
- `try/catch` 错误字符串

不要：

- 伪造 `tool_calls` 再发给模型
- 把检索结果再塞进 assistant 历史
- 为 eval 另写 `for` 循环版 ReAct

## 5. 判分（先这三条）

1. **轨迹**：`toolsInclude` 都必须出现；`toolsExclude` 一个都不能出现  
2. **输出**：`mustNotMatch` 命中任一条则 fail  
3. **稳定性**：`mustSucceed: true` 时抛错则 fail

控制台建议一行一条：

```
PASS  time-now
FAIL  kb-toggle-off  toolsExclude:searchDocs  output:命中「第 10 节」
```

最后打印 `passed/total`。全绿不是本课硬性目标；**能稳定复现你已知的坏行为并标红**，比刷绿更重要。

## 6. 和 Tracing 怎么配合

1. 先 `LANGCHAIN_TRACING_V2=false` 跑完整张卷  
2. 对 FAIL 的 id，打开 Tracing，用同一 `messages` + `searchDocs` 再发一次  
3. 看是 prefetch 没跑、模型乱引用历史，还是 LLM 400

## 7. 本课验收清单

- [ ] `dataset.json` 含开 / 关 / 切换三类知识库题
- [ ] 一条 npm 脚本能跑完并给出 pass/fail
- [ ] 故意关掉知识库问资料题，对应 Example 会红
- [ ] 没有改聊天 UI，没有接 LLM 裁判，没有测 `/api/rag/chat`

## 8. 下一课

**错误恢复与降级策略**（计划待写）。  
**Token 统计与成本控制** 后置到部署/成本页前后再学，本课不展开。
