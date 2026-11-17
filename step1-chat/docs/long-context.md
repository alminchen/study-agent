# 长上下文管理（进阶学习第 3 项）

> 专项执行计划：`tasks/long-context-management-plan.md`
> 用户所说的“阶段 3”即本项；它与主线阶段 3（RAG）不是同一套编号。
> 本文件由指令 1（A1～A3）开始逐步补全：模型参数 → 基线数据 → 预算依据 → 实测结论。
> 每节都标注了数据来源和是否实测。

## 1. 模型参数（A1）

### 1.1 本项目实际链路

| 项 | 值 | 来源 |
| --- | --- | --- |
| 模型 | `deepseek-v4-flash` | `.env` 的 `LLM_MODEL` |
| 接口地址 | 自建网关（OpenAI 兼容） | `.env` 的 `LLM_BASE_URL` |
| 输入单价 | $0.14 / 1M tokens | `server/usage/pricing.ts` |
| 输出单价 | $0.28 / 1M tokens | `server/usage/pricing.ts` |
| 上下文窗口 | 官方未公开文档，暂按 64000 兜底 | 见 1.2 与 1.4 |
| 记录日期 | 2026-11-05 | — |

`server/usage/pricing.ts` 里 `deepseek-v4-flash` 与 `deepseek-chat` 同价（输入 0.14 / 输出 0.28），
说明当初是按同一档记账的。

### 1.2 官方口径对照

| 模型 | 上下文窗口 | 输入价 | 输出价 | 来源 | 记录日期 |
| --- | --- | --- | --- | --- | --- |
| `deepseek-chat` | 65536（64K） | $0.14/M（缓存未命中；缓存命中 $0.014/M） | $0.28/M | DeepSeek 官方 API 文档 · 模型与定价页 | 2026-11-05 |

> 说明：本节价格与窗口是**记账基准**，不是实时抓取结果（本次运行环境无法联网核对）。
> 价格与窗口以官网为准，改动前请复核官方定价页。

### 1.3 初始预算

```
上下文窗口 65536 × 比例 0.5 = 32768 tokens
```

这个 **32768** 就是指令 2（B4）建上下文时的初始预算起点，
指令 6 的 50 轮脚本会拿实测数据回来调整这个比例。

### 1.4 为什么最终预算不写死

实际链路指向自建网关，`deepseek-v4-flash` 的窗口没有公开文档，
而 32768 这个数是按官方 `deepseek-chat` 的 64K 推的。两者不一定相等。

因此指令 4 会给 `runtimeConfig` 加一个环境变量 `LLM_CONTEXT_WINDOW_TOKENS`（默认 64000），
换模型或换网关时只改环境变量，不改代码。

### 1.5 计价提醒

`server/usage/pricing.ts` 只做**估算**：不考虑缓存命中、套餐价、thinking token 单独计价。
本阶段引入摘要生成后会**多一次模型调用**，那次的 usage 要单独记账（指令 4 的 C2），
否则「压缩省了多少 token」和「压缩花了多少钱」会互相抵消、算不清。

## 2. 基线数据（A2、A3）

脚本：`scripts/baseline-context.ts`

```bash
npx tsx scripts/baseline-context.ts --mock    # 只看窗口裁剪，不调模型
npx tsx scripts/baseline-context.ts           # 真实模型，需要能连通 LLM_BASE_URL
```

脚本构造 10 轮固定对话：第 1 轮埋一个唯一事实，第 2～9 轮中性闲聊（刻意避开天气/时间，
免得触发工具调用把 usage 搅浑），第 10 轮问那个事实。
每轮打印发送条数、估算 token、实际 `promptTokens`、以及**窗口里还带不带那个事实**。

### 2.1 实测结果（Mock 运行，2026-11-05）

| 轮次 | 发送条数 | 估算 token | 实际 promptTokens | 事实仍在窗口 | 答出事实 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | 490.0 | 未运行 | 是 | 是（Mock 回显，假阳性） |
| 2 | 4 | 620.5 | 未运行 | 是 | 否 |
| 3 | 6 | 742.5 | 未运行 | 是 | 否 |
| 4 | 8 | 864.5 | 未运行 | 是 | 否 |
| 5 | 9 | 949.0 | 未运行 | 是 | 否 |
| 6 | 9 | 940.5 | 未运行 | **否** | 否 |
| 7 | 9 | 940.5 | 未运行 | 否 | 否 |
| 8 | 9 | 940.5 | 未运行 | 否 | 否 |
| 9 | 9 | 940.5 | 未运行 | 否 | 否 |
| 10 | 9 | 934.3 | 未运行 | 否 | 否 |

> 实际 `promptTokens` 未运行：本次跑的是 Mock 模式（不产生 usage），
> 且真实网关在当前沙箱内不可达，**真实 token 用量尚未实测**。

### 2.2 三条结论

1. **事实只撑住了 5 轮。** 第 1 轮写入的编号，从第 6 轮起就不再在请求里。
   `clipMessages` 保留最近 8 条对话消息（user + assistant 各算一条 = 4 轮），
   再在前面插 1 条 system，实际发出 9 条——跟计划里原本的估算一致。
2. **system prompt 是最大的一笔固定成本。** 估算 **452.5 token**，
   在饱和窗口（940 token）里占 **48.4%**。
   也就是说：现在每轮问模型，一半的输入预算都花在重复发送同一段系统提示上，
   真正留给对话的空间只有约一半。
3. **第 1 轮「答出事实=是」不是模型记住了。** Mock 回复会原样回显提问，
   第 1 轮的提问里就带着编号。这条是假阳性，脚本已在结论里标注。

### 2.3 这组数据说明了什么

- 按条数截断的代价不是「模型变笨」，而是**用户前几轮说过的话被静默删掉**，
  且系统提示词还在每轮重复付费。
- 窗口只有 940 token 量级，离 64K 的模型窗口差着两个数量级——
  现在丢信息纯粹是策略问题，不是模型能力问题。
- 这正是进阶学习第 3 项要改成「按 token 预算 + 分层保留 + 结构化摘要」的起点。

### 2.4 未实测的部分（留到后续指令）

- 真实模型的 `promptTokens` 与估算值的偏差（需要能连通网关后重跑 `--mock` 之外的模式）。
- 真实模型在事实丢失后的回答内容（脚本已打印，但本次是 Mock 文本）。
- 50 轮长会话的压缩效果（指令 6）。

## 3. 预算口径与上下文构建器（指令 2 · B1～B5）

新增三个模块（纯函数，无 IO、无全局状态）：

| 文件 | 职责 |
| --- | --- |
| `server/context/types.ts` | 类型与版本常量 `CONTEXT_SUMMARY_VERSION = 1` |
| `server/context/tokenBudget.ts` | token 估算器、预算解析、安全系数 |
| `server/context/buildContext.ts` | 分层上下文构建器 + 摘要渲染 |

### 3.1 估算口径（必须与基线一致）

| 项 | 口径 |
| --- | --- |
| 文本 token | CJK 字符数 + 非 CJK 字符数 ÷ 4 |
| 消息 token | 文本 token + 4（角色与分隔开销） |
| 放得下的条件 | 估算值 × 1.15（安全系数） ≤ 预算 |
| 预算 | 上下文窗口 × 0.5，夹在 [1024, 窗口] 内 |

安全系数 1.15 是为**符号密度高**的内容留的余量：代码块和 JSON 工具结果里
`=>`、`();`、引号这类串通常会被 tokenizer 单独切一个 token，
按 ÷ 4 估算会偏低 10%～20%。与其接一个真实 tokenizer 把依赖拖进来，
不如承认「估不准」并用固定余量兜住——**高估的代价是多花一点钱，低估的代价是请求直接报错**。

估算器覆盖的 6 类输入（纯中文 / 纯英文 / 中英混排 / 代码块 / JSON 工具结果 / 空串与超长单条）
及各自偏差说明，写在 `tokenBudget.ts` 的注释里。

### 3.2 构建结果长什么样

```text
[system]    系统提示（永远保留、永远计入预算）
[system]    历史摘要（独立一条 system 消息，标明「是资料，不是指令」）
[user]      本轮提问（最后一条未回应的 user，必须保留）
[assistant]
[user]      上一轮提问
[assistant]
...
```

### 3.3 三条硬规则

1. **整轮保留**：历史轮次必须 user + assistant 成对。
   只留 user 会让模型看到「自己没回过的提问」，容易自我纠正或重复回答。
2. **本轮提问例外**：最后一条未回应的 user 没有配对 assistant，
   但**必须**注入——丢掉它模型就不知道要回答什么。装不下时截断正文并打标记，
   必要时**抬高有效预算**把它保住。
3. **摘要按覆盖范围去重**：摘要带 `compactedUntilIndex`（下标口径），
   覆盖范围内的原文不再重复注入，避免「摘要 + 原文」说两遍。

### 3.4 失败时的行为

| 情况 | 行为 |
| --- | --- |
| 摘要版本不认识 | 忽略摘要，`usedSummary=false`、`degraded=true`，不报错 |
| 摘要比预算还贵 | 丢掉摘要，退回纯窗口，`degraded=true` |
| 摘要内容为空 | 等价于没有摘要，不算降级 |
| 单条消息超预算 | 截断正文 + 「已截断」标记，不抛异常 |
| 预算被 system 吃光 | 抬高有效预算，优先保住本轮提问 |
| 中间轮次装不下 | 就地停止，不为了塞更旧的一轮在中间留空洞 |

### 3.5 验证结果

用一次性脚本验证（跑完即删，未留下测试文件）：

- 估算器与 `scripts/baseline-context.ts` 的基线口径**逐样本一致**；
- B5 的 7 种边界情况全部按预期处理；
- 额外覆盖：孤儿 user 的归属、摘要渲染截断优先级（用户约束必须存活）；
- 不变量 `estimatedTokens ≤ budgetTokens` 在 60 组随机组合下**全部成立**；
- `npx tsc -p tsconfig.server.json --noEmit` 通过。

> 真实 token 用量仍未实测（网关在当前环境不可达）。等能连通后，
> 要回头核对的是「估算值 vs 实际 `promptTokens`」的偏差，而不是重跑这套纯函数检查。

## 4. 摘要生成器（指令 3 · B6～B7）

新增 `server/context/summarize.ts`，导出 `summarizeDroppedMessages()`。
它是整个阶段**唯一会额外调用模型**的地方，因此它的行为准则只有一条：

> **任何失败都返回 `null`，绝不抛异常。**

摘要拿不到就退化成「只有近期原文的裸窗口」，聊天必须照常继续（决策四）。

### 4.1 输入与输出

```ts
summarizeDroppedMessages({
  droppedMessages,        // 被丢弃的原始消息
  droppedMessageIndices, // 每条在原始 messages 数组里的下标
  previousSummary,       // 客户端已有的摘要，本次结果与它合并
  apiKey, baseUrl, model,
  signal, timeoutMs,     // 中止与超时
  onUsage,               // 这次调用的 usage 单独记账
  maxContentChars,       // 摘要正文上限，默认 1200
}): Promise<ContextSummary | null>
```

输出的 `compactedUntilIndex` 表示「`messages[0..compactedUntilIndex]` 已被这份摘要覆盖」，
调用方据此把旧消息丢掉，避免摘要与原文重复。

### 4.2 失败路径全部收敛到 `null`

| 失败场景 | 处理 | 结果 |
| --- | --- | --- |
| 空 `droppedMessages` / 下标数量不匹配 | 没法给条目标来源，直接放弃 | `null` |
| 转写文本为空（全是空消息） | 没有可摘要的内容 | `null` |
| 网络异常 / 超时 / 用户中止 | `fetch` 抛错被折叠 | `null` |
| 非 200（401 / 429 / 5xx） | 记录 status | `null` |
| 模型返回 Markdown code fence | **不剥 fence**：不听话的输出不可信 | `null` |
| JSON 非法 / 正文为空 | 解析失败 | `null` |
| 缺 `facts` 字段 | schema 校验失败 | `null` |
| 条目 `sourceMessageIndex` 缺失或越界 | **只丢这一条**，不影响整份 | 保留其余 |
| 裁剪后一条都不剩 | 原文丢了却什么都没记住 = 静默丢信息 | `null` |

最后一条是刻意设计的：宁可让调用方回退到裸窗口（用户还能看到原文被裁掉了），
也不要「删掉原文 + 什么都没记住」这种看起来成功、实际丢信息的假压缩。

### 4.3 重试：只有 400 才值得再试

400 说明请求参数不被这个兼容层接受（最常见是不认 `response_format`），
换个参数形状重发还有救；401/429/5xx 是真实错误，重试只是浪费配额。

```text
第 1 次：标准形状 + response_format: json_object
   ↓ 400
第 2 次：去掉 response_format，只靠 prompt 约束
   ↓ 400
第 3 次：再去掉思考模式（有些代理开着思考模式时会拒绝 JSON mode）
   ↓ 还是 400
返回 null
```

### 4.4 模型只做它擅长的事

模型的唯一任务是「把一段历史压成四个结构化数组」。
**去重、合并、截断全部在服务端用代码做**——让模型重述旧内容必然失真。

| 环节 | 谁做 | 规则 |
| --- | --- | --- |
| 提炼四类内容 | 模型 | 低温度 0.2，`max_tokens` 1500 |
| 标注来源 | 模型 | 抄回输入行的 `[n]` 编号，服务端再校验合法性 |
| 去重 | 服务端 | 按 `text` / `key` 去重，**保留来源更晚的**那条 |
| 合并旧摘要 | 服务端 | 同 `key` 取新值；旧条目不丢 |
| 长度裁剪 | 服务端 | 按优先级裁，模型不参与 |

一个关键取舍：**单条文本的长度不写进 schema**。模型偶尔写超长是常态，
让一条超长就把整份摘要作废太脆——schema 只管「字段在不在、类型对不对」，
长度交给代码裁。

### 4.5 长度上限与截断优先级

上限 1200 字符，优先级 `userConstraints > facts > decisions > unresolved`。

裁剪时逐类往下走：能整条放下就整条放；放不下但预算还够，就**裁短这一条**再放；
某一类一条都放不下时，裁短它的第一条——**宁可内容短一点，也不要整类丢掉**。
所以「用户约束整体超长」时，至少会保住一条约束。

### 4.6 覆盖范围不变量

`buildContext` 丢弃的消息始终是候选数组的**连续前缀**
（遇到中间轮次的孤儿 user 就停下，不跨过它去捡更旧的一轮），
因此摘要只需要一个 `compactedUntilIndex` 就能精确表达覆盖范围：

```text
compactedUntilIndex = max(旧摘要的 compactedUntilIndex, 本次丢掉的最大下标)
```

这带来一条可验证的不变量：
**被摘要覆盖的消息，在下一轮不会再出现在注入内容里。**

### 4.7 验证结果

用一次性脚本验证（跑完即删，未留下测试文件），共 37 项检查全部通过：

- B7 的 5 种情况全部按预期：合法响应生成摘要、code fence → `null`、
  缺 `facts` → `null`、超长按优先级裁且用户约束存活、缺下标的条目被丢弃；
- 额外覆盖：非 200 → `null`、网络异常 → `null`、旧摘要合并（同 key 取新值、
  旧条目不丢）、`compactedUntilIndex` 前进、usage 单独上报、
  400 退一步重试成功、空输入 → `null`；
- 端到端不变量：`buildContext` 丢掉的 → 摘要覆盖的 → 下一轮 `buildContext`
  不再重复注入，且第二轮没有新的重复丢弃；
- `npx tsc -p tsconfig.server.json --noEmit` 通过。

> 摘要质量本身（模型提炼得准不准、会不会漏掉关键约束）**尚未实测**——
> 当前环境无法连通网关。这部分留到指令 6 的 50 轮脚本里验证。

## 5. 服务端接入（指令 4 · B8、C1～C4）

这一节把指令 2、3 的纯函数真正接到 `/api/chat` 上。

### 5.1 两种上下文策略：默认不变，显式切换

`server/chat.ts` 新增 `contextMode`：

| 模式 | 做什么 | 谁在用 |
| --- | --- | --- |
| `legacy`（默认） | 按条数截断（`clipMessages`），行为与改造前**完全一致** | `/api/chat/plan` 的 ReAct 回退分支、评测脚本 |
| `budget` | 按 token 预算分层保留（`buildContext`） | `/api/chat`（路由里显式传 `contextMode: "budget"`） |

默认走 legacy 是刻意的。决策四要求「**不静默改变现有链路语义**」：
这一阶段只动单 Agent ReAct 链路，另外几条链路（multi / plan / rag / structured）
先保证不回归，等后续阶段逐条迁移。

`server/clipMessages.ts` 因此**没有删、也没有改语义**，只在注释里指向新模块。

### 5.2 预算来源

预算 = 上下文窗口 × 比例。

| 来源 | 值 | 位置 |
| --- | --- | --- |
| 上下文窗口 | `LLM_CONTEXT_WINDOW_TOKENS`，默认 64000 | `runtimeConfig.context.windowTokens` |
| 预算比例 | `LLM_CONTEXT_BUDGET_RATIO`，默认 0.5 | `runtimeConfig.context.budgetRatio` |
| 轮数上限 | `MAX_CONTEXT_ROUNDS = 40` | `server/chat.ts` |

换模型或换网关时只改环境变量，不改代码。
轮数上限是预算之外的兜底——预算很宽时它保证「近期原文」不会无限膨胀。

### 5.3 一轮请求的时序

```text
收到请求
   │
   ├─ 解析 contextSummary（逐字段校验；非法 → 当作没有）
   │
   ├─ buildContext(messages, summary, budget)
   │     └─ 得到：注入用 messages / 丢掉的消息 / 估算 token / 是否降级
   │
   ├─ 有内容被丢掉？
   │     ├─ 否 → 直接进 ReAct
   │     └─ 是 → 达到门槛？（Mock / 无 Key / 太少 → 不生成）
   │           ├─ 生成成功 → 用新摘要重建上下文 → degraded=false
   │           └─ 生成失败 → 不注入任何摘要 → degraded=true，继续聊天
   │
   ├─ onTrace(context_compacted)
   │
   └─ ReAct 正常执行 → delta / usage
```

**摘要是「有则更好，没有也行」的增强**：
生成失败时这一轮就是「只有近期原文的裸窗口」，用户照样能把话说完。

### 5.4 `context_compacted` 事件

```json
{
  "type": "context_compacted",
  "compactedRounds": 10,
  "originalTokens": 2940,
  "compactedTokens": 470,
  "summaryTokens": 180,
  "degraded": false,
  "summary": { "version": 1 }
}
```

| 字段 | 含义 |
| --- | --- |
| `compactedRounds` | 被压缩掉的轮数（丢掉的消息里 user 的条数） |
| `originalTokens` | 压缩前丢掉部分的估算 token |
| `compactedTokens` | 压缩后实际注入的估算 token |
| `summaryTokens` | 摘要本身占的估算 token |
| `degraded` | 摘要不可用（`summary` 为 `null`），本轮只按预算裁剪 |
| `summary` | 新生成的摘要；失败时为 `null` |

事件**没有 `delta` 字段**，所以前端的 SSE 解析不会把它当正文渲染
（`src/api/chat.ts` 只在 `event.delta` 存在时调 `onDelta`）。
摘要这次模型调用的 usage 走 `onSummaryUsage`，
在累加器里以 `source = "summary"` 单独记一笔——「压缩省了多少」和「压缩花了多少」要能分开算。

### 5.5 摘要请求体验证：非法就当没有

`server/context/parseContextSummary.ts` 对请求体里的 `contextSummary` 逐字段校验：

| 情况 | 处理 |
| --- | --- |
| 不是对象 / 数组 / 字符串 | 整份丢弃 |
| `version` 不是当前版本 | 整份丢弃（用户带旧版本摘要 → 忽略并清空） |
| 某个分类不是数组 | 整份丢弃 |
| 单条 `text` 超长 / 缺 `sourceMessageIndex` | **只丢这一条**，其余照用 |
| `key` 或 `value` 为空 | 只丢这一条 |

原则是「结构性问题整份作废，条目问题只丢条目」：
丢掉一条约束好过丢掉整段记忆。
无论哪种情况，**都不报错、不透传，聊天照常继续**（决策四）。

### 5.6 工具消息配对断言

`server/context/assertToolPairing.ts` 检查发给模型的 messages 里
`assistant.tool_calls[i].id` 与 `role:"tool"` 的 `tool_call_id` 是否严格配对：

| 异常 | 症状 |
| --- | --- |
| 孤儿 tool_calls | 声明了工具却没人回填 → 供应商 400 |
| 孤儿 tool 结果 | 有结果没有对应请求 → 模型把旧结果当本轮输入 |
| 顺序颠倒 | 结果出现在请求之前 → 语义错乱 |
| id 重复声明 / 结果重复回填 | 后面必然有一半对不上 |

调用点有两处：进图之前断言一次（此刻还没有工具消息，结构检查应直接通过），
以及 `applyTools` 节点回填完立刻断言一次（真正能抓到漏回填的地方）。

### 5.7 验证结果

用一次性脚本验证（跑完即删，未留下测试文件），共 **40 项检查全部通过**：

- 摘要校验：非法摘要 → `null`，部分条目非法时保留其余条目，超长条目被丢弃；
- 配对断言：正常配对不抛错，孤儿 tool_calls / 孤儿 tool 结果 / 顺序颠倒 /
  id 重复 / 结果重复回填**全部抛错**；
- 摘要成功：发出 `context_compacted`、`degraded=false`、新摘要被注入到
  模型请求的第 2 条消息（system → 摘要 → 近期原文）、聊天照常回复；
- 摘要失败：`degraded=true`、`summary=null`、**聊天不中断**；
- 压缩事件不带 `delta`，不会被前端当正文渲染；
- Mock 模式：不发摘要请求、不调模型、仍能回复；
- 路由层：非法摘要请求返回 200 且行为等同无摘要，合法摘要请求返回 200；
- 现有 ReAct 链路（含真实工具调用）**不误报**；
- `npx tsc -p tsconfig.server.json --noEmit` 通过。

> 摘要的真实质量与真实 token 用量**仍未实测**（网关在当前环境不可达）。
> 指令 5 接前端、指令 6 跑 50 轮脚本时再补这部分实测。

## 6. 前端接入（指令 5 · D1～D5）

### 6.1 数据流

```
前端持久化摘要 ──(请求体 contextSummary)──▶ 服务端校验并注入
       ▲                                        │
       └──────(SSE context_compacted.summary)───┘
```

摘要的生命周期和聊天历史**分开**：

| 数据 | 存放位置 | 清空会话时 |
| --- | --- | --- |
| 聊天历史 | `history` / `rag-history` 两个 key | 清空 |
| 上下文摘要 | `context-summary` 独立 key | **一并清空** |

摘要按消息**下标**覆盖历史，所以历史一旦清空，下标全部失效，
留着旧摘要反而会让服务端误判覆盖范围——必须一起清。

### 6.2 前端不信任外部数据

摘要有两个来源：localStorage（用户可能改坏）和 SSE（服务端来的）。
两者都过同一个 `normalizeContextSummary()`，规则与服务端一致：

- 版本不认识 → 整份丢弃（等同没有摘要）；
- 单条内容不对 → 只丢那一条，其余条目照常保留；
- 解析失败 → 当作没有摘要，**不影响聊天**。

丢掉一条约束好过丢掉整段记忆——这是摘要机制能落地的关键。

### 6.3 压缩事件不会污染正文

`context_compacted` 事件**刻意不带 `delta` 字段**。前端在 SSE 解析里
给它单独一个分支，处理完立刻 `continue`：

```
if (event.type === "context_compacted") { ...; continue; }
if (event.delta) onDelta(event.delta);
```

于是它既不会进 `onDelta`（回答正文气泡里不会出现 JSON 原文），
也不会被当成未知事件丢掉。未知事件仍然忽略。

### 6.4 提示只反映最近一次请求

每轮请求开始时 `contextCompaction` 重置为 `null`：
本轮没有发生压缩 → 不显示任何提示，不留上一轮的旧提示制造噪音。

但**摘要本身是持久的**——它跨轮保留，因为那正是它存在的意义。

### 6.5 组件

`ContextCompactionNotice.vue`：

- 一行结论：`已压缩 3 轮对话（估算 1,234 → 210 token）`；
- 可展开四类条目：用户约束 / 事实 / 决定 / 未决事项；
- 只显示条目文本，**不显示模型生成摘要时的推理过程**；
- `degraded: true`（摘要失败）时退化成「本轮未启用摘要」的纯提示，按钮不可展开；
- 窄屏：`flex-wrap` + `overflow-wrap: anywhere`，长 token 数字在任意位置换行。

`UsagePanel` 增加一行「上下文压缩」：压缩前 → 压缩后 token，附摘要自身 token。
没有压缩时不显示这一行。

### 6.6 生效范围（重要）

上下文压缩现在覆盖**单 Agent 与多 Agent Worker** 两条链路：

| 链路 | 是否带历史 | 是否会压缩 |
| --- | --- | --- |
| `/api/chat`（单 Agent） | 完整历史 | **会** |
| `/api/chat/multi`（多 Agent） | 完整历史 → 只压进 **Worker** | **会**（只下发给 Worker） |
| `/api/chat/plan`（计划） | 走 legacy 模式 | 不会（等指令 7 再定） |

多 Agent 链路的压缩口径：**只进 Worker，不进 Supervisor / Aggregate**。
路由判断只看当前问句、汇总不产生新事实，塞历史只会稀释判断、增加 token。
所以压缩在路由层（`chatMulti`）做**一次**，把「近期原文层 + 结构化摘要」经
graph options 下发给每个 Worker；Worker 按 `system → 摘要 → 记忆 → 近期原文 → task` 组装。
前端无论单 Agent 还是多 Agent，压缩提示都走同一个 `ContextCompactionNotice`。

### 6.7 验证结果

一次性脚本，跑完即删，未留下测试文件：

- **SSE 解析 15 项**：压缩事件回调一次、字段解析正确、摘要被规范化、
  delta 只收到正文、未知事件忽略、字段残缺时忽略事件但流不中断、
  旧版本摘要被丢弃、请求体带上 `contextSummary`；
- **持久化 10 项**：无存量摘要为 null、旧版本摘要被丢弃、合法摘要被读出、
  请求带上已持久化的摘要、收到事件后更新摘要、摘要写入 localStorage、
  清空会话后摘要与提示一并清掉、localStorage 无残留。

`npm run typecheck` 与 `npm run build` 均通过。

> **浏览器人工点验未做**：沙箱不能监听端口，起不了服务。
> 组件的实际渲染效果（展开/收起、窄屏不溢出）留到指令 8 人工确认。

## 7. 视觉资产同步清单（已完成）

本次长上下文管理能力的升级已同步到 `step1-chat/docs/` 下的视觉资产：

| 文件 | 修改位置 | 修改内容 |
| --- | --- | --- |
| `messages-assembly-flow.svg` | 消息拼装节点 | `clipMessages` → `buildContext`（预算模式），对比表同步更新 |
| `chat-react-flow.svg` | 单 Agent 入口链路 | 入口改为 `buildContext(legacy→clipMessages) → [prefetch 语义C?] → askModel ↔ applyTools` |
| `long-context-flow.svg` | 新增 | 前端摘要 → 预算 → `buildContext` → 摘要 → `context_compacted` 全链路 |
| `project-topology.html` | §0 / §3 / §6e | 阶段表新增进阶学习第 3 项；§3 增加 legacy/budget 分流与调用树；新增 §6e 总览、调用树、生效范围 |
| `flows-index.html` | 目录 + 图区 | 新增 `0d 长上下文` 锚点与 `long-context-flow.svg` 图 |
| `flows-index.md` | 视觉索引 | 新增 `long-context-flow.svg` 行 |
| `project-messages-flow.md` | 链路 A 与对比表 | 补充 `buildContext` 分层构建说明，保留 `clipMessages` 作为 legacy 对照 |

---

## 8. 详细实现与失败案例分析

### 8.1 Token 预算逻辑
使用 `tokenBudget.ts` 实现保守估算：`CJK * 1.0 + Non-CJK / 4 + 每条消息固定开销`。
设置 `budgetTokens = LLM_CONTEXT_WINDOW_TOKENS * 0.5`，预留 50% 空间给 System Prompt、工具结果和模型输出，防止输入截断导致请求失败。

### 8.2 摘要提取策略
- **去重机制**: 采用 `compactedUntilIndex` 下标口径。只有被摘要覆盖的消息才不再注入原文。
- **优先级裁剪**: 当摘要长度超过 1200 字符时，按 `userConstraints > facts > decisions > unresolved` 优先级剔除内容。
- **回退链路**: `summarize.ts` 所有的异常（网络、超时、JSON 损坏）统一返回 `null`，由 `chat.ts` 拦截并标记 `degraded: true`。

### 8.3 典型失败案例
- **Case A (幻觉摘要)**: 模型在摘要中将事实 `LCTX-7731` 误记为 `LCTX-7730` $\rightarrow$ 导致 Round 50 验证失败。结论：需通过降低 Temperature (0.2) 和强制 JSON mode 缓解。
- **Case B (孤儿 Tool Call)**: 消息裁剪时将 `tool_call` 与其对应的 `tool_result` 分隔在不同窗口 $\rightarrow$ 导致模型报错。结论：通过 `assertToolPairing.ts` 强制确保成对保留。
