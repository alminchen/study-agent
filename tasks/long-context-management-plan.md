# 进阶学习第 3 项：长上下文管理专项计划

> 用户所说的“阶段 3”，对应 `tasks/plan.md` 推荐执行顺序里的第 3 项：长上下文管理。
> 本文只规划这一项，不并入其他方向的实现，也不开始写代码。
>
> 目标项目：`step1-chat/`
>
> 当前状态：**计划已写完，代码尚未实现**。本文中的文件清单、事件名和任务编号
> 都是待执行的目标，不代表仓库里已经存在这些文件。

## 0. 一句话结论

这项学习不是“把 `maxContextMessages` 从 8 改成 64”，而是给聊天链路补上一层
**可预算、可压缩、可观察**的上下文管理：系统消息固定保留、最近几轮保留原文、
更早的轮次压成结构化摘要、原始输入始终控制在 token 预算内，并且用户能看见
“哪几轮已经被压缩、摘要里还留着什么”。

**执行步骤在第 7 节，共 8 条可下达指令**（内部含 26 个子任务）。
每条指令 = 一个完整可交付的工作单元，包含「改哪些文件、做什么、什么算完成」，
你只需要说「执行指令 N」就能开工，中途可以随时叫停。

---

## 1. 为什么现在要学这条路径

### 1.1 现在这条链路的“上下文管理”只有一个数字

当前 `/api/chat` 的全部上下文策略是这一行：

- `step1-chat/server/clipMessages.ts`：`messages.slice(-Math.max(1, maxContextMessages))`，
  再在前面固定插一条 system。
- `step1-chat/server/routes/chat.ts`：调用点写死 `maxContextMessages: 8`。
- `step1-chat/server/chat.ts`：`MAX_CONTEXT_MESSAGES = 8` 是默认值。

也就是说：**只按条数截断，既不看 token 长度，也不区分消息角色，更不记得被丢掉的内容**。

由此产生的真实问题，按严重程度排序：

1. **早期约束会静默消失。** 用户第 2 轮说“回答一律用中文、不要用 emoji”，第 20 轮再问
   同一个话题时，这条约束已经不在窗口里，模型会“忘记”并被用户当成模型不稳定。
2. **8 条不是 8 轮。** 一轮问答至少是 user + assistant 两条，所以 8 条 ≈ 4 轮对话。
   多 Agent、Plan、工具轮还会插入更多消息，实际可用轮次更少。
3. **条数裁剪和 token 成本脱钩。** 4 条超长中文和 4 条“好的”占用的 token 差两个数量级，
   但它们在裁剪时权重完全相同。
4. **system prompt 是固定成本，但没有被算进任何预算。** 当前 system prompt 包含工具规则、
   知识库开关说明和安全约束三段，每次请求都要整段重发。
5. **没有任何“发生过压缩”的信号。** 用户和开发者都不知道信息在第几轮被丢掉，
   出错时无法定位，只能凭感觉怀疑“模型是不是忘了”。

### 1.2 这条路径是后续多个方向的共同地基

| 后续方向 | 对上下文管理的依赖 |
| --- | --- |
| Vision（第 4 项） | 图片会占用额外 token，必须和文本一起算预算；消息协议要先稳定 |
| Memory（第 5 项） | 记忆注入本质是往上下文里加内容，必须先有预算和摘要的位置 |
| Tool 动态发现（第 8 项） | 工具 schema 本身占 system token，工具变多时预算更紧张 |
| AB 测试 / 在线 Evals（第 10 项） | 要比较不同 prompt 的效果，前提是每次请求的上下文长度可比、可控 |

尤其注意 **Memory 和长上下文会互相影响**：如果上下文不管理，跨会话记忆注入的内容
会挤掉真正的近期对话；如果上下文管理做得太激进，摘要会把记忆里的事实冲掉。
先做长上下文，再做 Memory，顺序才是对的。

### 1.3 这条路径的学习价值不只在 AI 侧

它会实际训练下面这些工程能力，每一条都能迁移到别的项目：

- **把“感觉够用”的阈值变成有单位的预算。** 从“留 8 条”变成“注入不超过 N token”。
- **设计有损但可验证的信息压缩。** 摘要不是随意的缩写，而是带 schema、可校验、可回退的数据结构。
- **处理分布式的状态。** 摘要在前端生成、前端持久化、服务端消费，三方要有一致的版本和幂等规则。
- **给“看不见的行为”加可观测性。** 压缩了多少轮、压缩前后各多少 token、摘要花了多少钱。
- **写能复现长会话的测试。** 50+ 轮的固定脚本，而不是靠手动聊天“感觉它还记得”。

---

## 2. 长上下文管理是什么

### 2.1 四个必须分开的概念

这四个词经常被混着说，但它们解决的是完全不同的问题：

| 概念 | 回答的问题 | 事实 |
| --- | --- | --- |
| 上下文窗口（context window） | 模型一次最多能吃多少 token | 由模型决定，是硬上限，超了直接报错 |
| 输入预算（token budget） | 这一次请求你**打算**用多少窗口 | 由应用决定，通常只占窗口的一部分 |
| 上下文压缩（compaction） | 装不下时，丢掉什么、保留什么 | 应用负责，模型不参与决策 |
| 摘要（summary） | 丢掉原文前，先把信息压成什么形态 | 压缩的一种手段，用一次模型调用换信息密度 |

关键关系是：

> 窗口是上限，预算是你的策略，压缩是超预算时的动作，摘要只是压缩的一种实现。

再往前推一步：**“换一个窗口更大的模型”不等于“做了上下文管理”**。
大窗口只是把问题推后：成本随轮次线性增长，且模型在超长输入里的“中段遗忘”
（lost-in-the-middle）依然存在，长输入的延迟和价格也会明显上升。

### 2.2 常见策略对比

| 策略 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 硬截断（现状） | 只留最近 N 条 | 零成本、零延迟、实现极简 | 早期信息静默丢失，且 N 是条数不是 token |
| 只放大 N | 留最近 50 条 | 改一行就能做 | 成本不可控；长上下文召回并不线性变好 |
| 滑动窗口 + 摘要 | 近期原文 + 早期摘要 | 成本有上限，重要信息可保留 | 多一次模型调用；摘要有失真风险 |
| 分层保留 | system 固定 → 近期原文 → 早期摘要 → 其余丢弃 | 角色和优先级清晰 | 需要显式定义层级顺序 |
| 外部检索 | 把历史切块存向量库，按需召回 | 理论上信息不丢 | 复杂度最高；本项目已有 RAG 链路但那是资料问答，不是聊天记忆 |

本阶段选择 **分层保留（滑动窗口 + 结构化摘要）**，理由见第 4 节。

### 2.3 一个完整的数据变化过程

假设用户连续聊了 50 轮，第 3 轮说过一句“我的项目用 Vue 3 + Vite，不要用 webpack”。
当第 51 轮提问时，期望的上下文组装是：

```text
[system]  （工具规则 + KB 开关 + 安全约束 + 摘要提示）
[system]  （结构化摘要：facts / decisions / unresolved / constraints）
[user]    第 47 轮
[assistant] 第 47 轮
[user]    第 48 轮
...
[user]    第 51 轮
```

其中摘要里应当能看到：

```json
{
  "facts": [{ "key": "project_stack", "value": "Vue 3 + Vite", "sourceMessageIndex": 5 }],
  "decisions": [{ "text": "不使用 webpack", "sourceMessageIndex": 5 }],
  "unresolved": [{ "text": "尚未确定测试框架", "sourceMessageIndex": 12 }],
  "userConstraints": [{ "text": "回答用中文，不使用 emoji", "sourceMessageIndex": 3 }]
}
```

而第 4～46 轮的原文**不再出现在请求里**。压缩动作本身要通过 SSE 告诉前端：

```json
{ "type": "context_compacted", "compactedRounds": 44, "originalTokens": 18240, "compactedTokens": 4310, "summaryTokens": 380 }
```

### 2.4 本项目现状与目标状态对照

| 环节 | 现状 | 目标 |
| --- | --- | --- |
| 裁剪规则 | 按条数取最近 8 条 | 按 token 预算分层选择 |
| system 处理 | 前插一条固定 system | 固定保留，且计入预算 |
| 早期信息 | 直接丢弃 | 压成结构化摘要，可校验、可回退 |
| 工具结果 | ReAct 单请求内增长，跨轮不进历史 | 保持现状并加配对检查 |
| 压缩可见性 | 无 | `context_compacted` 事件 + 前端提示 |
| 摘要状态 | 无状态，服务端不存 | 前端持久化 + 版本号 + 幂等 |
| 失败行为 | 无失败概念 | 摘要失败回退硬窗口，聊天不中断 |
| 成本记录 | 只有总 usage | 记录压缩前后 token 与摘要开销 |

---

## 3. 它能为用户做什么

这一节用“用户能感知到什么”来描述收益，避免只讲内部实现。

1. **长会话不再丢约束。** 50 轮之后仍然记得早期说过“用中文”“项目用 Vue 3”
   “不要改 `src/` 目录”这类长期指令。
2. **回答更稳定，成本反而可控。** 注入 token 有上限，第 5 轮和第 50 轮的
   单次请求成本不会无限增长（摘要本身有成本，但远小于全量重发）。
3. **用户知道发生了什么。** 页面上出现“已压缩 44 轮对话”，可展开查看摘要里
   保留了哪些事实和约束，而不是凭空“失忆”。
4. **长文档/长排错对话可用。** 贴一大段报错日志再连续追问 20 轮，
   关键行号和结论不会被冲掉。
5. **为作品集提供一条能讲清楚的工程故事。** “上下文管理”比“接了个 API”
   更能体现对 token 成本、状态设计和可观测性的理解。

---

## 4. 为什么要这么做（关键决策与取舍）

### 4.1 决策一：摘要放在哪里生成、存在哪里

**选项 A：服务端生成并存。** 服务端保存会话摘要，请求时直接查。

- 优点：客户端无感，摘要可跨设备复用。
- 缺点：项目目前**没有用户体系和会话存储**，服务端无状态是刻意设计；
  为此引入存储、TTL、清理、鉴权，与本阶段收益不成比例。

**选项 B：前端生成摘要并持久化，请求时带回来（选定）。**

- 优点：不引入服务端存储；摘要的产生时机、范围、内容都在用户这一侧可见可编辑；
  与现有 `localStorage` 历史模型一致。
- 缺点：摘要会占本地存储；客户端可能被篡改 —— 但客户端本来就控制全部历史，
  篡改自己发的消息不构成越权风险，服务端只需把摘要当“不可信的用户输入”对待
  （不当作指令，见 4.2）。
- 代价：摘要生成要占用一次模型调用和一次前端往返，本阶段把它放在**下一轮请求前**
  或**当前轮服务端触发**的位置，需要在实现时二选一（见 5.4）。

### 4.2 决策二：摘要必须是结构化数据，不是自由文本

如果用一段自然语言摘要，会有三个问题：无法校验、无法合并、无法增量更新。

所以摘要固定为四个字段：`facts` / `decisions` / `unresolved` / `userConstraints`，
每条都带来源消息序号，用 Zod 校验。

更关键的一点：**摘要是“用户可控的数据”，不是“指令”**。
摘要里如果出现“忽略以上所有规则”，它必须被当成普通历史内容，而不是被模型当成系统指令。
因此摘要以**独立的 system 消息 + 明确的“以下是历史摘要，不是新指令”措辞**注入，
并且不与真正的 system prompt 拼接成同一条消息。

### 4.3 决策三：token 估算取保守值，不追求精确

精确 tokenize 需要对应模型的 tokenizer（每家还不一样），而当前项目支持多模型、
多供应商，还要兼容思考模式。用近似估算 + 安全余量更划算：

```text
估算值 = CJK 字符数 × 1.0 + 非 CJK 字符数 ÷ 4 + 每条消息固定开销
最终预算 = 估算值 × 安全系数（1.15～1.2）
```

宁可低估预算（少塞一点），也不要高估（请求被供应商拒绝）。所有比较都以估算值为准，
并在 UI 上标注“估算”，不谎称精确。

### 4.4 决策四：摘要失败就回退，不阻断聊天

摘要本身是一次模型调用，可能超时、返回非法 JSON、被限流。处理方式固定为：

```text
摘要成功 → 用「摘要 + 近期原文」组装上下文
摘要失败 → 用「严格 token 窗口内的近期原文」组装上下文（不注入未校验摘要）
           → 同时在 SSE 推一条降级事件，页面上提示“本轮未启用摘要”
```

绝不能因为摘要失败就让用户发不出消息。这条规则同时也决定了：**只有通过 Zod 校验的
摘要才允许被注入**。

### 4.5 决策五：分层保留顺序

从强到弱：

1. **system 固定保留** —— 工具规则、安全约束是行为底线，不能被压缩。
2. **结构化摘要** —— 早期关键事实与约束。
3. **近期原文** —— 最近 N 轮完整对话。
4. **其余丢弃** —— 并且要告诉用户丢到哪儿了。

为什么不反过来先放摘要再放 system？因为摘要必须紧跟 system 才能被模型当作“背景资料”
而不是“最近刚说过的话”；但摘要永远不能排在 system 前面，否则摘要里的内容
会显得比真正的系统规则更新、更权威。

### 4.6 决策六：不静默改变现有链路语义

和第 1、2 项一样，本阶段必须满足：

- 新能力有明确开关或新入口，不改变 `/api/chat`、`/api/chat/multi`、`/api/rag/chat`
  三条链路的默认语义。
- 预算默认取一个**保守但比现在大**的值，让它表现为“更聪明地保留”，而不是
  “突然换了行为”。
- 未携带摘要的旧历史、Mock 模式、离线 Evals 全部照常工作。

### 4.7 决策七：范围只覆盖单 Agent ReAct 链路

当前四条链路的上下文处理方式各不相同：

| 链路 | 当前上下文处理 | 本阶段是否纳入 |
| --- | --- | --- |
| `/api/chat` | `clipMessages` 最近 8 条 | **是**，主战场 |
| `/api/chat/plan` | Planner / Executor 自己组织消息 | 否，只保证不回归 |
| `/api/chat/multi` | 多 Agent 各自只用最后一句 user | 否，只保证不回归 |
| `/api/chat/structured`、`/api/rag/chat` | 结构化 / 检索各自链路 | 否，只保证不回归 |

把四条链路一次拉齐会让本阶段失控。先在 `/api/chat` 上把上下文管理做对、
做出可测的 50 轮脚本，再考虑推广。

---

## 5. 数据流设计

### 5.1 协议字段

**请求（`POST /api/chat`）新增可选字段：**

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "contextSummary": {
    "version": 1,
    "updatedAt": 1762300000000,
    "compactedUntilMessageId": "msg_1700000000_3",
    "facts": [{ "key": "project_stack", "value": "Vue 3 + Vite", "sourceMessageIndex": 5 }],
    "decisions": [{ "text": "不使用 webpack", "sourceMessageIndex": 5 }],
    "unresolved": [{ "text": "尚未确定测试框架", "sourceMessageIndex": 12 }],
    "userConstraints": [{ "text": "回答用中文", "sourceMessageIndex": 3 }]
  }
}
```

**响应新增 SSE 事件：**

```json
{ "type": "context_compacted", "compactedRounds": 44, "originalTokens": 18240,
  "compactedTokens": 4310, "summaryTokens": 380, "degraded": false }
```

**摘要生成的响应（若采用前端生成方案）：**

```json
{ "type": "context_summary_ready", "summary": { ... }, "coveredMessageIds": ["..."] }
```

### 5.2 一轮对话的时序

```text
用户发第 N 轮
   │
   ├─ 前端：把 contextSummary（如果本地已有）一起发出
   │
   ├─ 服务端：buildContext(messages, summary, budget)
   │     ├─ 1. 固定 system
   │     ├─ 2. 注入 summary（若存在且校验通过）
   │     ├─ 3. 从最近一条往回装，装到预算为止
   │     ├─ 4. 记录 dropped 范围
   │     └─ 5. 若 dropped 范围超过阈值 → 需要生成新摘要
   │
   ├─ 服务端：ReAct 图正常执行（历史里的工具消息成对检查）
   │
   ├─ SSE：delta / usage
   │
   └─ SSE：context_compacted（若有压缩发生）
         │
         └─ 前端：把新摘要写回 localStorage，页面显示“已压缩 N 轮”
```

### 5.3 上下文构建算法（分层）

```text
buildContext(messages, summary, budget):
  1. system = 系统提示（按 searchDocs 开关拼装）
  2. 估算 system token，从预算里扣除
  3. 若 summary 存在且通过校验：
       注入一条独立的 system 摘要消息（标明来自历史摘要）
       从预算里扣除
  4. 从 messages 尾部向前累加：
       遇到完整的一轮（user + assistant）才加入
       加上后若超出预算 → 停止
  5. 输出：{ systemMessages, recentMessages, droppedRange, tokenEstimate }
```

注意第 4 步的**整轮加入**：历史轮次里不能只留 user 留 assistant，那会让模型看到一个
“自己没回过的提问”，容易触发自我纠正或重复回答。

**但最后一条未回应的 user 是例外**：它就是用户这一轮的提问，没有配对的 assistant
（还没生成），却必须注入——丢掉它模型就无从回答。它单独保留，必要时截断内容。

### 5.4 摘要生成的位置（两个候选，本阶段二选一）

| 方案 | 触发时机 | 优点 | 代价 |
| --- | --- | --- | --- |
| A. 服务端生成 | 服务端发现 dropped 范围超阈值，本轮请求内顺便调模型生成摘要，随本轮响应返回 | 一次往返；服务端掌握完整原始历史 | 本轮响应变慢；多一次模型调用写进 usage |
| B. 前端生成 | 前端在“下一轮发送前”判断需要压缩，先调独立接口生成摘要再发消息 | 不拖慢当前回答；用户可看到并编辑 | 多一次往返；摘要与实际发送的消息存在时间差 |

**倾向选 A**：服务端手里才有完整的原文（前端传上来的是已裁剪的历史时更明显），
而且能保证“摘要覆盖的就是本次真正丢掉的那几轮”，不会出现摘要与被丢弃内容错位。
若实现中 A 明显拖慢首字，则改用 B 并在文档里记录取舍。

### 5.5 幂等与版本

- `version`：摘要结构版本号，格式变化时递增；服务端遇到不认识的版本直接忽略摘要
  （等同没有摘要），不报错。
- `compactedUntilMessageId`：摘要覆盖到哪一条为止。服务端收到摘要时，
  会把本地 messages 里**已经在摘要覆盖范围内**的旧消息也一并丢掉，避免重复。
- 摘要里的 `sourceMessageIndex` 用于定位，不参与注入顺序决策。

---

## 6. 关键技术细节

### 6.1 token 估算器

```ts
估算一条消息的 token ≈ CJK 字符数 × 1.0
                   + 非 CJK 字符数 ÷ 4
                   + 4（角色与分隔开销）

最终注入预算 = 估算总量 × 1.15（安全余量）
```

必须覆盖的输入形态：

- 纯中文长文本。
- 纯英文长文本。
- 中英混排。
- 含代码块（含大量符号与缩进）。
- 含 JSON 工具结果。
- 空消息与超长单条消息（单条就超预算时的降级行为）。

### 6.2 摘要的生成约束

- 用结构化输出（复用第 1 项已建成的结构化协议）生成摘要，而不是自由文本。
- 摘要 prompt 明确要求：只提炼**事实、决定、未决事项、用户约束**四类，
  不复述闲聊，不写解释性废话。
- 每条摘要项必须带 `sourceMessageIndex`；模型给不出来的项直接丢弃，不臆造。
- 摘要总长度有上限（例如 1200 字符），超了就按优先级截断：
  `userConstraints` > `facts` > `decisions` > `unresolved`。
- 摘要请求本身要用**低温度**，并单独记 usage（要能看出“压缩花了多少”）。

### 6.3 工具消息配对

事实澄清：当前前端历史里**只有 user / assistant 纯文本**（`src/types.ts` 的
`ChatMessage.role` 就是 `"user" | "assistant"`），工具调用与工具结果只存在于
单次请求内的 ReAct 图状态中，不跨轮持久化。

因此：

- 跨轮压缩不会切断工具配对，因为历史里没有工具消息。
- 但 ReAct 内部的消息数组会随轮次增长（`MAX_MODEL_TURNS = 5`），
  仍要做“assistant+tool_calls 与 tool result 成对”的断言，防止将来有人把工具
  消息写进历史时静默破坏协议。
- 一旦未来把工具结果纳入历史，压缩必须把 `assistant(tool_calls)` 与
  `tool(tool_call_id)` 当作**不可分割的一对**保留或整对丢弃。

### 6.4 旧历史兼容

- `loadHistory` 读到没有 `contextSummary` 字段的旧历史时，按“无摘要”处理。
- 本地存储的摘要在 `version` 不认识时丢弃并清空，避免脏数据反复报错。
- 摘要字段缺失或非法 JSON 时忽略，不影响聊天。

### 6.5 成本与可观测性

每次压缩要能回答四个问题：

1. 压缩前估算多少 token？
2. 压缩后注入多少 token？
3. 摘要生成用了多少 token、多少钱？
4. 摘要里的内容够不够？（靠 50 轮脚本回测）

这四个数字写进 trace 与 usage 记录，`UsagePanel` 里能看到。

---

## 7. 执行步骤

下面每一步都写清「改哪个文件 / 写什么 / 什么算完成」。
顺序不可随意调换：**每一步的完成判定满足后再做下一步**。

### 7.0 总览

**怎么下指令**：直接说「执行指令 N」或「执行指令 N 和 N+1」。
每条指令独立可交付，**不跨指令混做**。

| 指令 | 目标 | 包含子任务 | 依赖 | 主要产出 |
| --- | --- | --- | --- | --- |
| 1 | 基线与预算定稿 | A1～A3 | 无 | 模型参数表、基线脚本 |
| 2 | 上下文核心纯函数 | B1～B5 | 指令 1 | `types/tokenBudget/buildContext` |
| 3 | 摘要生成器 | B6～B7 | 指令 2 | `summarize.ts` |
| 4 | 服务端接入 | B8、C1～C4 | 指令 3 | `/api/chat` 用上预算与摘要 |
| 5 | 前端接入 | D1～D5 | 指令 4 | 压缩提示、摘要持久化 |
| 6 | 50 轮长会话脚本 | E1～E2 | 指令 5 | 长会话脚本与结论 |
| 7 | 回归与数据 | E3～E4 | 指令 6 | 数据表、五链路回归 |
| 8 | 文档与清单收尾 | E5～E6 | 指令 7 | `docs/long-context.md`、todo 更新 |

**最省事的开法**：指令 1 和指令 2 可以一起下（「执行指令 1、2」），
它们都不依赖未决决策，做完就有第一份可测数据。

---

### 指令 1 · 基线与预算定稿（A1～A3）

#### A1 · 记录目标模型参数

- **动作**：查 `deepseek-chat` 的官方上下文窗口与当前输入/输出单价，
  与 `step1-chat/server/usage/pricing.ts` 里已有的 `inputPer1M/outputPer1M`
  对齐，写进 `step1-chat/docs/long-context.md`（新建，先只写这一节）。
- **产出**：`docs/long-context.md` 里的「模型参数」表格：模型名、窗口、
  输入价、输出价、单价来源、记录日期。
- **完成判定**：能直接算出「窗口的 50% 是多少 token」，这个数字就是 B4 的初始预算。

#### A2 · 写 10 轮基线脚本，量化“8 条截断”到底丢了什么

- **动作**：新增 `step1-chat/scripts/baseline-context.ts`。
  - 构造 10 轮固定对话：第 1 轮写入唯一事实
    （例：`FACT_CODE = "purple-otter-42"`），其余 9 轮为无关键信息的寒暄。
  - 每轮调用 `createChatStream`（Mock 或真实模型），打印：本轮发送的 messages 条数、
    估算 token、实际 `usage.promptTokens`。
  - 第 10 轮提问“FACT_CODE 是什么”，打印回答，**用来证明现在答不出来**。
- **完成判定**：脚本能复现「第 1 轮的事实已经不在请求里、模型答不出」。
  这是后面所有改动的对照基准，必须先有。

#### A3 · 量 system prompt 的固定成本占比

- **动作**：在 A2 脚本里额外打印 system prompt 的估算 token，
  以及它占当轮 promptTokens 的百分比。
- **完成判定**：文档里有一行「system 占比 X%」。

---

### 指令 2 · 上下文核心纯函数（B1～B5）

#### B1 · 定义类型与常量

- **动作**：新增 `step1-chat/server/context/types.ts`：
  ```ts
  export const CONTEXT_SUMMARY_VERSION = 1;
  export interface ContextSummaryItem { text: string; sourceMessageIndex: number; }
  export interface ContextSummary {
    version: number;
    updatedAt: number;
    compactedUntilMessageId: string | null;
    facts: Array<{ key: string; value: string; sourceMessageIndex: number }>;
    decisions: ContextSummaryItem[];
    unresolved: ContextSummaryItem[];
    userConstraints: ContextSummaryItem[];
  }
  export interface ContextBuildResult {
    messages: TextMessage[];      // 最终发给模型的
    droppedMessages: TextMessage[]; // 被丢掉、待摘要的
    estimatedTokens: number;
    budgetTokens: number;
    usedSummary: boolean;
    degraded: boolean;             // 摘要不可用时的降级标记
  }
  ```
  同时定义 SSE 事件 `context_compacted` 的 payload 类型。
- **完成判定**：类型与第 5.1 节协议字段一一对应，没有多余字段。

#### B2 · 写 token 估算器

- **动作**：新增 `step1-chat/server/context/tokenBudget.ts`：
  - `estimateTextTokens(text: string): number`
    —— CJK 字符 × 1.0 + 非 CJK 字符 ÷ 4。
  - `estimateMessageTokens(message: TextMessage): number`
    —— 正文估算 + 4（角色与分隔开销）。
  - `estimateMessagesTokens(messages: TextMessage[]): number`
  - `resolveBudgetTokens(contextWindow: number, ratio: number): number`
    —— 窗口 × ratio，并夹在 `[minBudget, contextWindow]` 内。
- **完成判定**：四个函数都是纯函数，无 IO、无全局状态。

#### B3 · 明确估算器要覆盖的输入形态

- **动作**：在估算器实现里明确覆盖这 6 类输入（写进注释，说明每类怎么算）：
  - 纯中文长串
  - 纯英文长串
  - 中英混排
  - 含代码块（大量符号与缩进）
  - 含 JSON 工具结果
  - 空字符串与单条超长消息
- **完成判定**：6 类输入都有明确处理方式，估算偏差可接受的原因写在注释里
  （不额外建测试文件）。

#### B4 · 写上下文构建器

- **动作**：新增 `step1-chat/server/context/buildContext.ts`：
  ```ts
  export function buildContext(params: {
    messages: TextMessage[];
    summary: ContextSummary | null;
    systemPrompt: string;
    budgetTokens: number;
    maxRecentRounds?: number;
    summaryMaxChars?: number;
  }): ContextBuildResult
  ```
  实现顺序严格按 5.3：
  1. system 计入预算；
  2. summary 存在且版本匹配 → 渲染成一条**独立**的 system 摘要消息并计入预算；
  3. 从尾部往前**整轮**加入 user+assistant，直到超预算；
     但**最后一条还没被回应的 user 是「本轮提问」，必须保留**（必要时截断内容），
     否则模型根本看不到用户这一轮问了什么；
  4. 剩下的进 `droppedMessages`；
  5. summary 里 `compactedUntilMessageId` 已覆盖的旧消息直接丢弃，不重复保留。
- **完成判定**：函数返回的 `messages` 顺序是「system → 摘要 → 近期原文」。

#### B5 · 明确构建器要覆盖的边界情况

- **动作**：在 `buildContext` 里覆盖这 7 种情况（每处加注释说明对应第 9 节哪条失败路径）：
  - 超预算时丢弃最早的消息，且 `droppedMessages` 顺序正确；
  - 最后一条未回应的 user（本轮提问）**必须保留**；
    中间历史的孤儿 user（被下一个 user 顶替）不单独保留，改为进 `droppedMessages` 交给摘要器；
  - 有摘要时摘要排在 system 之后、近期原文之前；
  - 摘要版本不认识时被忽略，`usedSummary === false`；
  - `compactedUntilMessageId` 覆盖范围内的消息不重复出现；
  - 单条消息超预算时被截断并标记，不抛异常；
  - `estimatedTokens <= budgetTokens` 恒成立。
- **完成判定**：7 种情况都有对应处理，且每处能指出对应哪条失败路径
  （不额外建测试文件）。

### 指令 3 · 摘要生成器（B6～B7）

#### B6 · 写摘要生成器

- **动作**：新增 `step1-chat/server/context/summarize.ts`：
  - `summarizeDroppedMessages(params): Promise<ContextSummary | null>`
  - 内部复用第 1 项的结构化输出能力：低温度 + JSON mode + Zod 校验。
  - 校验失败 / 超时 / 非法 JSON → 返回 `null`（**不抛异常**）。
  - 长度上限 1200 字符，超出按 `userConstraints > facts > decisions > unresolved` 截断。
  - 每条必须带 `sourceMessageIndex`；缺失的丢弃。
- **完成判定**：失败时返回 `null` 而不是抛错——这是 4.4 决策四的实现落点。

#### B7 · 明确摘要生成器要覆盖的失败与边界

- **动作**：在摘要生成器里覆盖这 5 种情况（每处加注释）：
  - 合法结构化响应 → 摘要正确生成；
  - 返回 Markdown code fence → 判定失败，返回 `null`；
  - 字段缺失（没有 `facts`）→ 校验失败，返回 `null`；
  - 超长摘要 → 按优先级截断，`userConstraints` 一定还在；
  - `sourceMessageIndex` 缺失的条目被丢弃。
- **完成判定**：5 种情况都有明确处理，其中 3 种失败路径统一收敛到「返回 null」
  （不额外建测试文件）。

---

### 指令 4 · 服务端接入（B8、C1～C4）

#### B8 · 保留 clipMessages 的旧行为

- **动作**：`step1-chat/server/clipMessages.ts` **不删不改语义**，
  只加一行注释指向新模块（`buildContext` 是新链路用的）。
  新链路不复用 `clipMessages`。
- **完成判定**：老函数仍然可被 `server/chat.ts` 调用，行为与现在完全一致。

#### C1 · `server/chat.ts` 接上下文构建

- **动作**：
  - `CreateChatStreamOptions` 增加 `contextSummary?: ContextSummary | null`、
    `contextWindowTokens?: number`、`contextBudgetRatio?: number`。
  - 用 `buildContext()` 取代 `clipMessages()`（保留 `maxContextMessages` 参数，
    作为「最近保留多少轮」的兜底上限，默认为一个足够大的值）。
  - 预算来源：`contextWindowTokens` 缺省时读 `runtimeConfig` 新增的
    `LLM_CONTEXT_WINDOW_TOKENS`（默认 64000），比例默认 0.5。
- **完成判定**：不带 `contextSummary` 的请求行为与现在**一致**（除条数变成按预算）。

#### C2 · `server/chat.ts` 接摘要生成与失败回退

- **动作**：
  - `buildContext` 返回 `droppedMessages.length > 0` 且超过阈值时，
    调用 `summarizeDroppedMessages()` 生成新摘要。
  - 摘要成功 → `options.onTrace?.({ type: "context_compacted", ... })`，
    并把新摘要通过 `onTrace` 一并回传（字段名 `summary`）。
  - 摘要失败（返回 `null`）→ `degraded: true`，**不注入任何摘要**，
    照常用「近期原文」继续聊天。
  - 生成摘要的模型调用**单独计 usage**（复用 `onUsage` 回调，模型名标注
    `summary` 用途），成本可查。
- **完成判定**：摘要失败不阻断聊天，且 trace 里能看到 `degraded: true`。

#### C3 · `server/routes/chat.ts` 收参数、推事件

- **动作**：
  - 请求体解析新增可选 `contextSummary`；**必须逐字段校验**（版本号、数组、
    字符串长度上限），非法就当没有摘要，不报错、不透传。
  - 传给 `createChatStream`。
  - `onTrace` 已有透传逻辑，`context_compacted` 事件自动到达前端；
    确认它不会被当成 `delta` 渲染。
- **完成判定**：非法 `contextSummary` 的请求返回 200 且行为等同无摘要。

#### C4 · 工具消息配对断言

- **动作**：新增 `step1-chat/server/context/assertToolPairing.ts`：
  - `assertToolPairing(messages: ProviderMessage[]): void`
  - 校验每个 `assistant.tool_calls[i].id` 都有对应 `tool.tool_call_id`，
    反向也要有；孤儿消息直接抛错。
  - 在 `runConversation` 进入图之前调用一次。
- **完成判定**：孤儿 tool_calls、缺失 tool result、顺序颠倒三种情况都会抛错；
  现有 ReAct 链路不会误报。

---

### 指令 5 · 前端接入（D1～D5）

#### D1 · 前端类型

- **动作**：`step1-chat/src/types.ts` 增加 `ContextSummary`、
  `ContextSummaryItem`、`ContextCompactionEvent`，字段与服务端**同名同义**。
- **完成判定**：前端类型与服务端 `server/context/types.ts` 逐字段对齐。

#### D2 · 解析压缩事件

- **动作**：`step1-chat/src/api/chat.ts` 的 SSE 解析里识别
  `type === "context_compacted"`，回调 `onContextCompacted`；
  **未知事件必须被忽略**（现有解析已经是这个行为，确认没被破坏）。
- **完成判定**：收到压缩事件不会让文本气泡里出现 JSON 原文。

#### D3 · 摘要的持久化与发送

- **动作**：`step1-chat/src/composables/useChat.ts`：
  - 新增 `contextSummary` ref，独立 localStorage key（与历史分开存）。
  - 发请求时带上 `contextSummary`。
  - 收到 `context_compacted` 后更新并持久化。
  - 清空会话时摘要一并清空。
  - 读取时校验 `version`，不认识就丢弃。
- **完成判定**：旧历史（没有摘要字段）加载时不报错、不影响聊天。

#### D4 · 压缩提示组件

- **动作**：新增 `step1-chat/src/components/ContextCompactionNotice.vue`：
  - 一行提示「已压缩 N 轮对话（估算 X → Y token）」
  - 可展开查看四类摘要条目，只显示条目文本，不显示推理过程
  - `degraded: true` 时显示「本轮未启用摘要」
- **完成判定**：组件在窄屏不溢出（沿用现有 `index.css` 的间距与字号变量）。

#### D5 · 挂载与用量展示

- **动作**：`step1-chat/src/App.vue` 挂载提示组件；
  `step1-chat/src/components/UsagePanel.vue` 增加压缩前后 token 行。
- **完成判定**：不压缩时不显示任何提示（不制造噪音）。

---

### 指令 6 · 50 轮验收脚本（E1～E2）

#### E1 · 50 轮长会话脚本

- **动作**：新增 `step1-chat/scripts/test-long-context.ts`：
  - 第 3 轮写入唯一事实 `FACT_CODE = "purple-otter-42"`；
  - 第 4～50 轮为无关键信息对话；
  - 第 51 轮问“FACT_CODE 是什么”；
  - 打印每轮的：发送条数、压缩前估算 token、压缩后估算 token、摘要开销、
    是否命中事实。
- **完成判定**：第 51 轮回答里出现 `purple-otter-42`。

#### E2 · 三条路径都要跑

- **动作**：E1 脚本加开关，支持三种模式：
  - 无摘要（纯预算裁剪）
  - 摘要成功
  - 摘要失败（人为让摘要接口返回非法 JSON）
- **完成判定**：摘要失败模式能继续聊天，且日志显示 `degraded: true`。

### 指令 7 · 回归与数据（E3～E4）

#### E3 · 记录数据

- **动作**：把 E1/E2 的输出整理成表（压缩前/后 token、摘要开销、命中率、延迟），
  写进 `step1-chat/docs/long-context.md`。
- **完成判定**：能回答「压缩省了多少 token」「摘要花了多少」「命中率高不高」。

#### E4 · 回归五条链路

- **动作**：跑通 `/api/chat`、`/api/chat/multi`、`/api/chat/plan`、`/api/rag/chat`、
  `/api/chat/structured`，确认上下文改造没有波及它们。
- **完成判定**：全部通过；若有失败，判定为本次改动引入并修掉。

### 指令 8 · 文档与清单收尾（E5～E6）

#### E5 · 写文档

- **动作**：`step1-chat/docs/long-context.md` 补齐：
  概念区分、预算比例与依据、实测数据、**摘要失真的真实案例**、
  为什么选这个策略、什么情况下应该关掉它。
- **完成判定**：没有“感觉上是这样”的结论。

#### E6 · 回写清单

- **动作**：`tasks/todo.md` 第 3 节按实际结果勾选，并写上实测结论
  （例如「50 轮命中：是；压缩节省：约 42%」）；没跑的部分明确写「未运行」。
- **完成判定**：清单不能只打勾，必须带实测结论。

---

### 执行纪律

1. **一次只做一条指令。** 指令内的子任务可以连续做完，但不要跨指令混做。
2. **每条指令结束时要满足它的「完成判定」。** 不满足就留在当前指令修，不要往下走。
3. **每条指令都要有文件变化。** 只写笔记不算完成。
4. **不擅自扩范围。** 计划外的想法记到文档末尾，不当场实现。
5. **指令 2、3 全部完成前不碰前端。** 纯函数先绿，再接线。
6. **真实模型不可用时如实标注。** Mock 结果不能写成实测结论。

---

## 8. 建议文件

**新增**

- `step1-chat/server/context/types.ts`
- `step1-chat/server/context/tokenBudget.ts`
- `step1-chat/server/context/summarize.ts`
- `step1-chat/server/context/buildContext.ts`
- `step1-chat/server/context/assertToolPairing.ts`
- `step1-chat/src/components/ContextCompactionNotice.vue`
- `step1-chat/scripts/baseline-context.ts`
- `step1-chat/scripts/test-long-context.ts`
- `step1-chat/docs/long-context.md`

**修改**

- `step1-chat/server/clipMessages.ts`（保留旧行为，新逻辑另起函数）
- `step1-chat/server/chat.ts`
- `step1-chat/server/routes/chat.ts`
- `step1-chat/server/usage/types.ts`（新增压缩/摘要的用量字段或独立记录）
- `step1-chat/src/types.ts`
- `step1-chat/src/api/chat.ts`
- `step1-chat/src/composables/useChat.ts`
- `step1-chat/src/App.vue`（挂压缩提示组件）
- `step1-chat/src/components/UsagePanel.vue`（展示压缩前后 token）
- `tasks/todo.md`（勾选 3.x 完成项并写实际结论）

---

## 9. 失败路径

| 失败场景 | 预期行为 |
| --- | --- |
| 摘要模型超时或返回非法 JSON | 丢弃未校验摘要，回退严格 token 窗口，聊天不中断，推降级事件 |
| 单条消息本身就超过预算 | 截断该条内容并标记，不让整个请求失败 |
| 中英混排导致估算偏低 | 安全余量 1.15 兜底；估算值与实际 usage 的偏差写进文档 |
| 摘要重复或漏掉第 3 轮关键约束 | 50 轮脚本必须能复现；摘要 schema 增加来源序号便于回溯 |
| 摘要调用比直接裁剪还贵 | 记录成本对比；必要时改成“每 N 轮才摘要一次” |
| 用户带旧版本摘要 | 忽略摘要并清空，不报错 |
| 用户手动改坏本地摘要 JSON | 解析失败时当作无摘要 |
| 前端刷新时摘要与历史不同步 | 摘要带 `compactedUntilMessageId`，服务端以此去重 |
| 中止请求时摘要已生成 | 不写回本地存储，不产生 usage 记录 |
| 压缩通知丢失 | 摘要本身持久化在本地，刷新后仍能显示压缩状态 |

---

## 10. 验收标准

**功能**

- [ ] 50 轮之后仍能引用第 3 轮写入的唯一事实和用户约束
- [ ] 注入 token 不超过配置预算
- [ ] 摘要失败自动回退，聊天不中断，且页面有降级提示
- [ ] 工具调用与工具结果始终成对
- [ ] UI 能说明压缩了哪些轮次，摘要可展开查看

**兼容**

- [ ] 旧历史（无摘要字段）可正常加载和继续聊天
- [ ] Mock 模式不触发摘要生成
- [ ] 摘要结构版本不匹配时安全忽略
- [ ] 五条既有链路回归通过

**质量**

- [ ] 类型检查与构建无报错
- [ ] 既有三条评测链路回归通过
- [ ] 压缩前后 token、摘要开销有可查记录
- [ ] 文档写明：估算值不是精确值、摘要会失真、为什么选这个预算比例

---

## 11. 与其他阶段的关系

```text
第 1 项 Streaming 结构化输出   → 提供摘要生成所需的结构化能力
第 3 项 长上下文管理（当前）   → 提供预算、摘要、压缩状态
   ├── 第 4 项 Vision          → 图片 token 计入同一预算
   ├── 第 5 项 Memory          → 记忆注入与摘要的优先级需要协调
   └── 第 10 项 在线 Evals     → 上下文长度可控，实验变量才可比
```

---

## 12. 本阶段明确不做的事

- 不引入服务端会话存储、用户体系或数据库。
- 不做向量检索式记忆（那是第 5 项 Memory 的范围）。
- 不改造 `/api/chat/multi`、`/api/chat/plan`、RAG、结构化四条链路的上下文逻辑
  （只保证不回归）。
- 不做跨会话的长期记忆（同样属于第 5 项）。
- 不引入 tiktoken 等精确 tokenizer 依赖（首版用保守估算）。
- 不追求把窗口用满；预算比例宁小勿大。

---

## 13. 交付物清单

1. 本文档：`tasks/long-context-management-plan.md`（本文件）。
2. 代码：`server/context/*`、`src/components/ContextCompactionNotice.vue`、
   `scripts/test-long-context.ts` 及相关改动。
3. 验收脚本：基线脚本（10 轮）与长会话脚本（50 轮）。
4. 文档：`step1-chat/docs/long-context.md`（概念、预算比例、实测数据、失真案例）。
5. 清单：`tasks/todo.md` 中第 3 节勾选完成项并写实际结论。

---

## 14. 执行前需要你确认的两点

1. **摘要生成位置**：5.4 里 A（服务端本轮顺带生成）vs B（前端下一轮前生成）。
   计划倾向 A，若拖慢首字则切 B。
2. **预算比例**：首版建议先取“上下文窗口的 50%”做基线，再用 50 轮脚本的数据
   调整；这个数值需要真实模型价格和窗口大小才能定稿（见任务 3.1）。

