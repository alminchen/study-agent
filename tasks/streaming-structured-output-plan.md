# 进阶学习第 1 项：Streaming 结构化输出专项计划

> 用户所说的“阶段 1”，对应 `advanced-learning-plan.md` 中的第 1 项。
> 本文只规划这一项，不另建阶段体系，也不开始实现代码。
>
> 当前状态：**阶段学习、代码实现与文档已完成（2026-11-04）**。任务 1.1 的
> 浏览器基线观测、真实模型调用、构建和运行回归按用户约束未执行，因此仍保留
> “运行未实测”边界；这不影响本阶段学习计划的完成标记。
>
> 目标项目：`step1-chat/`
>
> 最终交付（按实际约束调整）：一个独立的结构化聊天端点、一个可观察 partial
> JSON 的页面、学习总结与全链路图，以及手写 parser 与 Vercel AI SDK
> `useObject` 的静态对比结论。专项测试文件已按用户要求删除；运行实测仍待授权。

## 0. 一句话结论

这项学习不是“让页面上的文字一个字一个字出现”，而是让模型先生成一份有 schema 的结果，
服务端在结果尚未完整时持续解析出可验证的中间态，再通过 SSE 推给前端，
让表格逐行出现、代码逐段出现、表单逐字段填充，最后仍由 Zod 校验完整结果。

---

## 1. 为什么现在要学这条路径

### 1.1 当前项目里的“流式”不是模型原生流式

现有链路已经有 SSE，但模型调用本身固定为非流式：

- `step1-chat/server/react/complete.ts` 把 `stream` 固定为 `false`。
- 模型先把完整回答返回给服务端。
- `step1-chat/server/react/runConversation.ts` 在 `reply` 节点拿到完整文本后调用一次 `onDelta`。
- `step1-chat/server/routes/chat.ts` 再把这段最终文本包装成 SSE 的 `{ delta }` 事件。
- `step1-chat/src/api/chat.ts` 解析 SSE，`useChat.ts` 把 delta 拼回字符串。

所以当前具备的是：

- 浏览器能解析 SSE。
- 服务端能把最终文本按事件下发。
- 前端能更新普通文本气泡。

当前不具备的是：

- 模型 token 到达服务端后立即转发。
- JSON 在生成过程中被持续解析。
- 结构化字段的安全中间态。
- 表格、代码块或表单的增量渲染。
- partial 数据的中止、回退和非法结尾处理。

如果这层边界不先弄清楚，后面很容易把“SSE 分块”“模型 token 流”“结构化输出”
混成同一个概念，最后做出一个看似流式、实际上仍要等完整结果的实现。

### 1.2 它会影响后续多个进阶方向

下面几项都需要可靠的 schema 结果，而不是从自然语言里猜 JSON：

| 后续方向 | 对结构化输出的依赖 |
| --- | --- |
| Plan-and-Execute | 计划必须包含步骤、依赖、完成条件、状态和上限 |
| LLM-as-Judge | 风险级别、置信度、理由和命中规则必须可校验 |
| Reflection | 评分、问题清单和是否继续修订必须形成稳定对象 |
| Memory | 是否保存、保存什么、置信度和敏感信息判断必须结构化 |
| 在线 Evals | 必须稳定记录成功、失败原因、延迟和变体信息 |

这项能力做稳以后，后续功能是在同一个结构化协议上扩展。
如果跳过它，后面的 Planner、Judge 和 Reflection 会各自重复发明一套 JSON 解析。

### 1.3 学习价值不只在 AI，也在前端状态设计

这条路径会实际训练以下工程能力：

- 定义跨模型、服务端和浏览器的数据契约。
- 用 Zod 区分“形状正确”和“内容可信”。
- 处理不完整输入、非法输入和中途取消。
- 用单调递增的 revision 防止 UI 内容倒退或重复。
- 用 fixtures 测试不能稳定复现的网络分块。
- 比较自研协议与成熟 SDK 的控制力、依赖成本和维护成本。

---

## 2. Streaming 结构化输出是什么

### 2.1 四个概念必须分开

| 概念 | 解决的问题 | 发生了什么 |
| --- | --- | --- |
| 模型 token stream | 模型是否边生成边返回 | 供应商按 token 或更小的片段持续返回 `chat.completion.chunk` |
| SSE | 服务端如何持续把事件推给浏览器 | HTTP 响应保持打开，按 `data: ...\n\n` 发送事件 |
| 结构化输出 | 最终结果能不能被程序直接消费 | 结果符合 JSON Schema 或 Zod schema，而不是自由文本 |
| Streaming 结构化输出 | 结果未完成时能不能安全展示 | 服务端累积片段、partial parse、校验中间态、发送稳定快照 |

它们可以组合，但不能互相替代：

- 有 SSE，不代表模型原生流式。
- 模型在流式返回，不代表每个网络 chunk 都是完整 JSON。
- JSON mode 让最终答案更像合法 JSON，不代表中间片段随时可 `JSON.parse()`。
- Zod 校验最终结构，不代表里面的数据事实正确。

### 2.2 一个完整的数据变化过程

假设用户要求“生成一个三列、三行的模型对比表”，目标是：

```json
{
  "schemaVersion": 1,
  "block": {
    "kind": "table",
    "title": "模型对比",
    "columns": ["模型", "优势", "限制"],
    "rows": [
      ["A", "速度快", "上下文短"],
      ["B", "能力强", "成本高"],
      ["C", "成本低", "稳定性一般"]
    ]
  }
}
```

真实链路可能经历：

1. 模型先返回 `{"schemaVersion":1,"block":{"kind":"table",...`
2. 此时 JSON 整体不合法，不能直接 `JSON.parse()`。
3. 服务端识别出 `kind: "table"`，但尚无完整列信息，不发送可渲染快照。
4. `columns` 完整后，发送一个只有列、没有行的 partial snapshot。
5. 第一行完整后，发送包含 1 行的 snapshot。
6. 第二行完整后，发送包含 2 行的 snapshot。
7. 模型结束，拼接结果通过最终 Zod 校验。
8. 服务端发送 `structured_done`，页面从“生成中”切到“已完成”。

关键点不是“收到一个 chunk 就渲染一个 chunk”，而是：

> 网络 chunk 只是原材料，稳定快照才是前端应该渲染的数据。

### 2.3 为什么不能直接 `JSON.parse(chunk)`

以下情况都会让单个 chunk 不是合法 JSON：

- chunk 落在字符串中间，例如 `"模型对`。
- chunk 落在转义字符中间，例如反斜杠已经到达、引号还没到达。
- chunk 落在数组中间，例如 `[[\"A\",\"速度快\"`。
- 网络边界和 token 边界不一致，一个 chunk 可包含多个 token，也可能只包含半个字段。
- JSON mode 只约束完整响应，不承诺每个网络片段都能独立解析。

因此 parser 必须基于“到目前为止累计的文本”，并只接受能够证明完整的部分。

### 2.4 本项目现状与目标状态

| 环节 | 现状 | 目标 |
| --- | --- | --- |
| 模型请求 | `stream: false` | 新端点使用 `stream: true` |
| 服务端回调 | 最终文本到达后一次 `onDelta` | 每收到模型 chunk 都累积并尝试解析 |
| SSE 内容 | 文本 delta、trace、usage、DONE | 增加 start、delta 计数、snapshot、done、structured error |
| 最终校验 | 无结构化 schema | Zod 校验 `table | code` |
| 前端消息 | `content: string` | 新增独立结构化状态，不强行塞进纯字符串 |
| 页面渲染 | 单个文本气泡 | 表格或代码组件，带生成中、未完成和错误状态 |
| 自动测试 | 普通聊天评测 | partial fixtures、协议测试、失败路径测试 |
| 既有链路 | `/api/chat` 等已工作 | 不改原有语义，新能力走独立入口 |

---

## 3. 学完以后能为你和项目做什么

### 3.1 用户能直接看到的能力

| 场景 | 体验变化 |
| --- | --- |
| 模型对比表 | 列先出现，随后一行一行填充，不用等整张表结束 |
| 代码生成 | 代码块随内容到达而增长，最终再统一高亮或校验 |
| 配置卡片 | 名称、选项、默认值逐字段出现，而不是空白等待 |
| 执行计划 | 每个步骤先出现标题，再补齐动作和完成条件 |
| 评测结果 | 分数、理由和建议可以分块展示，同时保留最终对象 |

### 3.2 工程上能获得什么

- 前端消费的是可验证对象，不再从 Markdown 或自然语言里临时切表格。
- 服务端可以明确记录首字延迟、chunk 数、快照数和最终校验耗时。
- 中止时保留最后一个稳定快照，用户不会看到半行乱码。
- 非法结果有统一错误码，可以区分模型、网络、解析和 schema 问题。
- 后续 Planner、Judge、Reflection 可复用同一套“流式对象”基础。
- 可以做表格逐行、代码逐段等更接近真实产品的交互。

### 3.3 它不能解决什么

- Zod 通过只说明形状正确，不说明模型说的是事实。
- JSON mode 不能替代输出安全检查。
- partial snapshot 天然不完整，不能把中间态当成最终结论。
- schema 越严格，模型自由度越低，prompt 和 fallback 设计越重要。
- 不是所有供应商都支持相同 JSON mode 或 strict schema，需要能力探测和降级。
- 引入 SDK 也不自动解决业务语义、中止和持久化问题。

---

## 4. 本专项的范围与完成定义

### 4.1 首版范围

只做一个可学透、可验证的纵切：

- 新增独立 `POST /api/chat/structured`。
- 支持两种最终 block：`table` 与 `code`。
- 一次响应只生成一个 block，不先做多 block 混排。
- 模型使用原生 `stream: true`。
- 服务端做 partial JSON 解析和稳定快照。
- 前端显示增量表格或代码块。
- 支持停止、网络失败、非法 JSON、最终 schema 失败和迟到 chunk。
- 保留普通 `/api/chat`、`/api/chat/multi`、`/api/rag/chat` 原有行为。
- 用固定 chunk fixtures 做自动测试。
- 用真实模型跑至少一个表格场景。
- 完成一次 `useObject` 最小对比实验。

### 4.2 明确不做

- 不把所有聊天都改成结构化模式。
- 不一次性支持任意用户自定义 schema。
- 不做完整 Vercel AI SDK 迁移。
- 不做结构化消息的服务端持久化。
- 不做富文本编辑、单元格编辑和代码执行。
- 不把 partial 中间态写入长期聊天历史。
- 不为了“看起来流式”而每收到一个字符都触发一次 Vue 全量渲染。

### 4.3 最终演示必须满足

用户输入“生成一个三行的模型对比表”后：

1. 两秒内能看到表格骨架或第一行，而不是只看到加载动画。
2. 后续行逐步增加。
3. 结束后状态从“生成中”变成“已完成”。
4. 刷新页面后，只把已经完成的结构化结果作为历史消息保留。
5. 中途点击停止后，保留最后稳定快照并标明“未完成”。
6. 模型返回坏 JSON 时，页面显示可理解错误，不吐出 parser 堆栈。

---

## 5. 目标协议设计

这一节是后续实现的契约。编码前先确认这些决定，避免后端、前端和测试各自理解一套格式。

### 5.1 请求

```ts
interface StructuredChatRequest {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: string;
  target: "table" | "code";
  signal?: never; // 浏览器通过 fetch AbortSignal 控制，不放请求体
}
```

说明：

- `target` 由前端显式选择，首版不做自动分类。
- `messages` 沿用当前纯文本历史。
- 停止仍通过客户端 `AbortController`，服务端监听 `res.close`。
- 新端点不接工具、不触发人工确认，先把流式结构本身学清楚。

### 5.2 最终结果

首版只支持一个 block。使用判别联合，避免 table 与 code 字段互相污染。

```ts
type StructuredResult =
  | {
      schemaVersion: 1;
      block: {
        kind: "table";
        title: string;
        columns: string[];
        rows: string[][];
      };
    }
  | {
      schemaVersion: 1;
      block: {
        kind: "code";
        title: string;
        language: string;
        content: string;
      };
    };
```

Zod 最终校验至少包括：

- `schemaVersion` 必须为 `1`。
- `kind` 只能是 `table` 或 `code`。
- 表格至少有 1 列，列名非空，最多 8 列。
- 表格最多 50 行。
- 每一行的单元格数必须等于列数。
- 代码语言非空，内容最多 20,000 字符。
- 标题非空且最多 80 字符。

schema 上限不是为了刁难模型，而是为了限制界面尺寸、成本和失控输出。

### 5.3 中间快照

中间快照不是最终结果的“放宽版随便写”，而是只包含已经被证明稳定的数据。

```ts
type StructuredSnapshot =
  | {
      schemaVersion: 1;
      revision: number;
      block: {
        kind: "table";
        title: string;
        columns: string[];
        rows: string[][];
      };
    }
  | {
      schemaVersion: 1;
      revision: number;
      block: {
        kind: "code";
        title: string;
        language: string;
        content: string;
      };
    };
```

稳定规则：

1. 未识别出 `kind` 前不发 snapshot。
2. 表格列未完整前不发可渲染 snapshot。
3. 表格只收录已经闭合且列数匹配的行，最后半行不发送。
4. 代码内容只允许增长，不允许新 snapshot 比旧 snapshot 短。
5. `revision` 必须单调递增，前端只接受更大的 revision。
6. 最终 `structured_done.result` 必须通过完整 Zod schema。
7. 如果最终结果与最后快照冲突，不能静默替换成完全不同内容，应报协议错误。

### 5.4 SSE 事件

| 事件 | 用途 | UI 是否直接渲染 |
| --- | --- | --- |
| `structured_start` | 声明请求已进入结构化模式 | 显示生成中 |
| `structured_delta` | 报告已收到的模型片段数和累计字符数 | 否，只用于状态和诊断 |
| `structured_snapshot` | 发送已解析的稳定中间态 | 是，作为唯一增量数据源 |
| `structured_done` | 发送最终 Zod 校验通过的对象 | 是，切换为完成态 |
| `structured_error` | 发送可分类的解析、网络或模型错误 | 是，显示错误和重试入口 |
| `usage` | 沿用现有 token 统计 | 用量面板 |
| `[DONE]` | SSE 正常关闭哨兵 | 关闭读取循环 |

建议事件形状：

```ts
type StructuredSseEvent =
  | { type: "structured_start"; requestId: string; schemaVersion: 1 }
  | { type: "structured_delta"; sequence: number; receivedChars: number }
  | { type: "structured_snapshot"; revision: number; snapshot: StructuredSnapshot }
  | { type: "structured_done"; revision: number; result: StructuredResult }
  | {
      type: "structured_error";
      code:
        | "model_request_failed"
        | "model_stream_interrupted"
        | "partial_parse_failed"
        | "invalid_final_json"
        | "schema_validation_failed"
        | "provider_json_mode_unsupported";
      message: string;
      retryable: boolean;
      lastRevision: number;
    }
  | { type: "usage"; totalTokens: number; promptTokens: number; completionTokens: number };
```

注意：

- `structured_delta` 默认不把原始 JSON 塞给页面，只报告进度。
- 原始片段保存在服务端内存和 trace 中，失败时可用于诊断。
- 前端必须忽略未知事件，不能让新增事件导致 parser 崩溃。
- 正常结束仍需写 `[DONE]`，保持与现有 SSE 客户端习惯一致。

### 5.5 前后端状态机

服务端：

```text
idle
  -> requesting_model
  -> accumulating_chunks
  -> partial_parsing
  -> sending_stable_snapshot
  -> validating_final_result
  -> completed

任意阶段可进入：
  -> aborted
  -> failed
```

前端：

```text
empty
  -> streaming
  -> streaming_with_snapshot
  -> completed

streaming_with_snapshot 可进入：
  -> incomplete_after_abort
  -> failed_with_last_snapshot
```

前端永远以 `structured_snapshot` 为渲染源，以 `structured_done` 为成功源。
不要用 `structured_delta.receivedChars > 0` 推断内容已经可显示。

### 5.6 错误分类

| code | 含义 | 是否重试 |
| --- | --- | --- |
| `model_request_failed` | 模型 HTTP 请求失败 | 401/403 不重试，429/5xx 可重试 |
| `model_stream_interrupted` | 流在结束标记前断开 | 可重试 |
| `partial_parse_failed` | 当前累积文本无法安全解析 | 可继续等待，最终仍失败才报错 |
| `invalid_final_json` | 模型结束后仍不是 JSON | 可重试 |
| `schema_validation_failed` | JSON 合法但不符合 schema | 可重试一次 |
| `provider_json_mode_unsupported` | 供应商不接受 JSON mode | 走能力降级并明确标记 |

`partial_parse_failed` 不能在每个字符到来时立即终止。
partial parser 本来就预期遇到不完整输入，只有重试策略耗尽或最终文本仍非法时才算失败。

---

## 6. 可执行学习与实现步骤

任务按依赖顺序排列。每次只做一个任务，完成验收后再进入下一项。

### 任务 1.1：建立现状基线，跑通“假流式”观察

**目的**：亲眼确认现有 SSE 和模型原生流式不是一回事，给后续改进留下可比较基线。

**具体操作**

1. 阅读 `server/react/complete.ts`、`server/react/runConversation.ts`、`server/routes/chat.ts`。
2. 阅读 `src/api/chat.ts`、`src/composables/useChat.ts`、`src/components/ChatMessageItem.vue`。
3. 在本地启动应用，发送一个需要较长回答的问题。
4. 记录浏览器 Network 面板中 `/api/chat` 的首个 SSE 事件时间、最后一个事件时间和事件数量。
5. 记录服务端日志中模型返回时间与第一次 SSE 写出时间。
6. 画一张三层图：供应商响应、服务端 SSE、Vue 消息状态。
7. 写下三个问题的答案：
   - 当前 `delta` 是模型 token，还是完整文本的再次包装？
   - SSE 断开时，模型请求是否已经有 AbortSignal？
   - 当前 `ChatMessage.content` 为什么容纳不了 partial 结构化状态？

**涉及文件**

- 只读：`step1-chat/server/react/complete.ts`
- 只读：`step1-chat/server/react/runConversation.ts`
- 只读：`step1-chat/server/routes/chat.ts`
- 只读：`step1-chat/src/api/chat.ts`
- 只读：`step1-chat/src/composables/useChat.ts`

**失败路径**

- 如果本地没有 API Key，明确标注当前观察到的是 Mock 路径，不代表真实模型首字延迟。
- 如果只看代码不跑页面，不能把本任务标记完成。

**验收标准**

- 能用一句话解释 token stream、SSE、结构化输出、streaming structured output 的区别。
- 能指出当前代码中模型请求使用 `stream: false` 的具体位置。
- 留下一份基线数据，包括首事件时间、总耗时和事件数量。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npm run typecheck
npm run dev
```

**依赖**：无。

**规模**：S，约 45 至 60 分钟。

**执行记录（2026-10-30，只读核对）**

状态：进行中，不能勾选完成。已阅读任务指定的六个文件；按用户规则，没有启动
`dev`/`build`，没有发起聊天请求，也没有进行浏览器测量。

静态结论：

1. 当前 `/api/chat` 的 `delta` 不是模型 token。`requestCompletion` 在
   `server/react/complete.ts:56` 固定 `stream: false`，并在
   `server/react/complete.ts:74` 等待完整响应文本；`reply` 在
   `server/react/runConversation.ts:162` 对最终文本调用一次 `onDelta`；
   `server/routes/chat.ts:80-82` 再把这段完整文本包装成 SSE `{ delta }`。
2. SSE 断开时，模型请求已经有中止链路。`server/routes/chat.ts:49-52` 在响应
   非正常关闭时 abort；信号经 `server/chat.ts:106-115` 传到
   `ReactLoopOptions.signal`，最终由 `server/react/complete.ts:71` 交给模型
   `fetch`。
3. `ChatMessage.content` 在 `src/types.ts:3-7` 定义为单个字符串；
   `src/composables/useChat.ts:151-154` 只做字符串拼接；
   `src/components/ChatMessageItem.vue:20-25` 再把该字符串整体交给文本渲染。
   它没有地方表达“生成中/稳定的结构化对象、revision、字段是否完整、最终是否
   通过 schema”，所以不能可靠容纳 partial 结构化状态。

三层链路（当前单 Agent、非 Mock 路径）：

```text
供应商
  requestCompletion(stream:false)
  -> await response.text()
  -> 一次拿到完整 JSON
        |
        v
服务端 SSE
  LangGraph reply 节点
  -> onDelta(完整最终文本，一次)
  -> data: {"delta":"完整最终文本"}
  -> usage
  -> data: [DONE]
        |
        v
Vue 消息状态
  ReadableStream -> SSE parser
  -> onDelta(delta)
  -> ChatMessage.content += delta
  -> 单个字符串气泡重渲染
```

一句话区分：

- 模型 token stream：供应商边生成边把模型片段返回给服务端。
- SSE：服务端把业务事件持续推给浏览器。
- 结构化输出：最终答案能被程序按 schema 直接消费。
- Streaming 结构化输出：结果尚未完整时，从累计 JSON 中解析出可验证的稳定
  中间态，并持续推给 UI；最后仍做完整 schema 校验。

运行时待办（须获得用户明确授权后才能做）：

- 发送一个需要较长回答的问题。
- 记录首个 SSE 事件时间、最后一个事件时间、总耗时和 `delta` 事件数量。
- 对照服务端日志，记录模型返回与第一次 SSE 写出是否在同一时刻。
- 确认本次实际走 Mock 还是真实 API，并注明它是否能代表真实模型首字延迟。

---

### 任务 1.2：冻结首版 schema 和 fixtures

**目的**：先定数据契约，再写 parser 和 UI，防止三端边做边改格式。

**具体操作**

1. 新建 `server/structured/types.ts`。
2. 定义最终 `StructuredResult`、中间 `StructuredSnapshot`、SSE 事件和错误码。
3. 使用 Zod 定义 `StructuredResultSchema`。
4. 表格增加“每行列数等于 columns 长度”的校验。
5. 新建 `server/structured/fixtures/`，至少准备下列原始字符串：
   - 完整表格 JSON。
   - 完整代码 JSON。
   - 对象只到一半。
   - 字符串中有未转义完成的双引号和中文。
   - 字符串中有反斜杠转义。
   - 表格列完整、第一行完整。
   - 表格最后一行未闭合。
   - 代码内容包含换行和反引号。
   - 缺少 `block.kind`。
   - 最终 JSON 合法但列数不匹配。
6. 为每个 fixture 标注“预期发送 snapshot 的数量”和“预期最终是否通过”。
7. fixtures 必须是固定字符串，不能每次测试现场调用模型生成。

**涉及文件**

- 新增：`step1-chat/server/structured/types.ts`
- 新增：`step1-chat/server/structured/fixtures/partial-json.ts`
- 新增：`step1-chat/server/structured/schema.test.ts`

**失败路径**

- fixture 只覆盖完整 JSON，后续测试无法发现半行问题。
- 把 partial 中间态误用最终 schema 校验，会导致任何内容都展示不出来。
- 允许无限列和无限行，前端布局和成本会失控。

**验收标准**

- 最终 schema 与中间快照 schema 是两套明确类型。
- 10 类 fixture 全部存在，并说明预期 snapshot 行为。
- 合法与非法最终结果各至少有一个 Zod 测试。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/schema.test.ts
npm run typecheck
```

**依赖**：任务 1.1。

**规模**：M，约 60 至 90 分钟。

**执行记录（2026-10-30）**

- 已新增 `server/structured/types.ts`，分别定义最终 `StructuredResultSchema`、
  中间 `StructuredSnapshotSchema`、请求 schema、SSE 事件和六类错误码。
- 已新增 `server/structured/fixtures/partial-json.ts`，包含任务要求的 10 类固定
  raw 字符串，并标注“从空状态一次解析”的预期快照数和最终有效性。
- 已新增 `server/structured/schema.test.ts`，覆盖 fixture 数量、合法 table/code、
  列数不匹配和缺少 `block.kind`。
- `npx tsx --test server/structured/schema.test.ts`：4 tests passed。
- `npm run typecheck`：通过。
- 按用户规则，没有运行 `build`，没有启动浏览器，也没有进入任务 1.3 的 parser。

---

### 任务 1.3：用 TDD 实现 partial JSON 稳定快照

**目的**：把“不完整文本”转换成“可以安全展示的中间对象”，这是本专项的核心技术点。

**具体操作**

1. 新建 `server/structured/parsePartialJson.ts`。
2. 暴露一个纯函数，例如：

   ```ts
   interface PartialParseState {
     revision: number;
     lastRawLength: number;
     lastSnapshot: StructuredSnapshot | null;
   }

   function parseStructuredChunk(
     accumulatedText: string,
     previous: PartialParseState,
   ): {
     state: PartialParseState;
     nextSnapshot: StructuredSnapshot | null;
     diagnostic: string | null;
   };
   ```

3. parser 只接收累计文本，不直接读网络、不写 SSE、不改 Vue 状态。
4. 先补“未闭合对象”测试，再实现最小能力。
5. 先支持 `kind` 识别，再支持 table 的 columns、完整 rows。
6. 再支持 code 的 title、language 和递增 content。
7. 对未闭合字符串和转义字符返回“当前没有新快照”，不要抛到路由层。
8. 对新快照执行稳定规则检查，确保 revision 增加且内容不倒退。
9. 用 `structuredClone` 或等价方式隔离状态，避免测试之间互相污染。
10. 不用正则直接从文本里抓表格行；只有标准 partial JSON 解析不足时才加窄范围恢复逻辑。

**涉及文件**

- 新增：`step1-chat/server/structured/parsePartialJson.ts`
- 新增：`step1-chat/server/structured/parsePartialJson.test.ts`
- 复用：`step1-chat/server/structured/types.ts`
- 复用：`step1-chat/server/structured/fixtures/partial-json.ts`

**失败路径**

- 把半行放进 snapshot，页面出现一瞬后被改写。
- parser 每次都从零重建对象，revision 和已展示行重复。
- 未闭合引号触发异常并终止整个 SSE。
- code content 新快照比旧快照短，导致代码闪烁或倒退。
- 原样保留大量累积字符串并每次 O(n²) 重扫，长回答出现明显卡顿。

**验收标准**

- 所有 fixture 的 snapshot 数量和 content 增长符合预期。
- partial parse 失败不会抛出未处理异常。
- 同一输入重复调用不会产生重复行或更小 revision。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/parsePartialJson.test.ts
npm run typecheck
```

**依赖**：任务 1.2。

**规模**：M，约 90 至 120 分钟。

**执行记录（2026-10-30）**

- 已新增 `server/structured/parsePartialJson.ts`，暴露纯函数
  `parseStructuredChunk(accumulatedText, previous)`；parser 不读取网络、不写
  SSE，也不修改 Vue 状态。
- 已新增 `server/structured/parsePartialJson.test.ts`，覆盖未闭合对象、重复输入、
  表格半行、全部 fixture、表格骨架增长和代码内容单调增长。
- `half-object` 已有完整标题与 columns，按契约发送 0 行表格骨架，因此其预期
  snapshot 数修正为 1。
- 未闭合的代码字符串不发送 snapshot；表格只发送已闭合且列数匹配的行。
- 新快照必须保持 table/code 类型和元数据稳定，table 旧行不能修改，code content
  必须 append-only；revision 每次有效增长只增加 1。
- 返回状态中的快照使用 `structuredClone` 隔离，重复输入不会重复发送快照。
- 验证结果：`npx tsx --test server/structured/*.test.ts` 共 10 tests passed；
  `npm run typecheck` 通过。
- 按用户规则，没有运行 `build`，没有启动 dev server，也没有打开浏览器。

**检查点**：任务 1.1 至 1.3 完成后，先停下来复核概念、schema 和 parser 测试。
parser 不稳时不要接模型和 UI。

---

### 任务 1.4：实现模型 chunk 累积器和稳定快照发送器

**目的**：把网络层、解析层和 SSE 层解耦，让每层可以单独测试。

**具体操作**

1. 在 `server/structured/streamAccumulator.ts` 定义状态：
   - 累计原始文本。
   - 模型 chunk 数。
   - 收到的字符数。
   - 最近 revision。
   - 最近 snapshot。
   - 是否已结束。
2. `append(chunk)` 只做追加、更新计数、调用纯 parser。
3. `finish()` 拼接最终文本，执行最终 JSON 解析和 Zod 校验。
4. 提供 `getStats()`，至少返回首 chunk 时间、chunk 数、字符数、snapshot 数和解析耗时。
5. 明确 `append`、`finish`、`abort` 后的非法状态转换。
6. 为累积器写单元测试，不依赖 Express 或模型。
7. 使用至少三种切分方式切同一份完整 JSON：
   - 每 1 个字符一段。
   - 每 7 个字符一段。
   - 故意在引号、逗号和数组中间切段。
8. 三种切法最终都必须得到同一个通过 Zod 的对象。

**涉及文件**

- 新增：`step1-chat/server/structured/streamAccumulator.ts`
- 新增：`step1-chat/server/structured/streamAccumulator.test.ts`

**失败路径**

- 累积器同时承担 fetch、SSE 和 UI 更新，测试只能整条链路跑。
- 不同网络切法得到不同最终对象。
- finish 时忘记检查 `[DONE]`、finish_reason 或最后 residue，丢失尾部文本。
- abort 后仍允许 append，把迟到 chunk 写进状态。

**验收标准**

- 同一结果在三种分块方式下稳定得到相同 final。
- 收到迟到 chunk 时明确拒绝并记录诊断。
- `finish`、`abort` 和重复结束调用都有测试。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/streamAccumulator.test.ts
npm run typecheck
```

**依赖**：任务 1.3。

**规模**：M，约 60 至 90 分钟。

**执行记录（2026-10-30）**

- 已新增 `server/structured/streamAccumulator.ts`，公开
  `append(chunk)`、`finish()`、`abort()` 和 `getStats()`；累积器只处理文本、
  快照和终态，不读取网络、不写 SSE。
- 状态机固定为 `streaming -> completed | failed | aborted`，终态不可逆；迟到
  chunk、重复 finish、重复 abort 和反向终态转换均返回稳定诊断，不修改统计。
- `finish()` 区分 `invalid_final_json` 与 `schema_validation_failed`，失败时保留
  最后稳定快照并返回 revision。
- 已新增 `server/structured/streamAccumulator.test.ts`，覆盖三种 chunk 切法、
  表格增量快照、首 chunk/字符/耗时统计、非法最终 JSON、schema 失败、空流结束、
  abort 和全部终态保护。
- 验证结果：`npx tsx --test server/structured/*.test.ts` 共 22 tests passed；
  `npm run typecheck` 通过；`git diff --check` 通过。
- 按用户规则，没有运行 `build`，没有启动 dev server，也没有打开浏览器。

---

### 任务 1.5：先接固定 chunk mock，打通新 SSE 端点

**目的**：在接触真实模型前，把服务端 SSE 协议和失败收尾做通。

**具体操作**

1. 新建 `server/routes/chatStructured.ts`。
2. 注册 `POST /api/chat/structured`。
3. 复用 `setSseHeaders()`。
4. 校验请求体 `messages`、`model` 和 `target`。
5. 新增 Mock 分支：从固定 fixture 按可配置间隔发送 chunk。
6. 每次 append 后，如果有新 snapshot，就推送 `structured_snapshot`。
7. 正常结束推送 `structured_done`、`usage`（Mock 可没有）和 `[DONE]`。
8. 请求中止时停止定时器，推送或记录 aborted，不继续写已关闭响应。
9. 非法最终 schema 时推送 `structured_error`，不要只写通用 `{ error }`。
10. 在 `server/routes/index.ts` 挂载新路由。
11. 用 `curl -N` 或等价工具验证事件顺序。

**涉及文件**

- 新增：`step1-chat/server/routes/chatStructured.ts`
- 新增：`step1-chat/server/structured/mockStream.ts`
- 修改：`step1-chat/server/routes/index.ts`
- 复用：`step1-chat/server/routes/sse.ts`

**失败路径**

- 所有 snapshot 都攒到结束时一起发，又变成假流式。
- 客户端断开后定时器继续跑，服务端报 `ERR_STREAM_WRITE_AFTER_END`。
- 新端点误复用 `/api/chat` 的普通 `{ delta }`，前端无法区分。
- 新路由挂在 `/api/chat` 后面导致路径被通用处理截获。

**验收标准**

- 固定表格 fixture 能产生至少 3 个递增 snapshot。
- 事件顺序符合 start、snapshot、done、DONE 的状态机。
- 断开连接后服务端没有迟到写入或定时器残留。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npm run typecheck
npm run dev:server
curl -N -X POST http://localhost:8787/api/chat/structured \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"生成三行对比表"}],"model":"deepseek-v4-flash","target":"table"}'
```

**依赖**：任务 1.4。

**规模**：M，约 90 分钟。

---

### 任务 1.6：新增前端 structured SSE client

**目的**：在 API 层隔离普通文本流与结构化流，不让 `streamChat()` 越来越难维护。

**具体操作**

1. 在 `src/types.ts` 增加服务端事件和前端状态的共享类型。
2. 在 `src/api/chat.ts` 新增 `streamStructured()`，不要改写现有 `streamChat()`。
3. 复用现有“reader + TextDecoder + buffer + 按空行拆 event”的成熟部分。
4. 对 `structured_snapshot` 调用独立 `onSnapshot`。
5. 对 `structured_done` 调用 `onDone`。
6. 对 `structured_error` 调用 `onError`，保留 code、retryable 和 lastRevision。
7. 未知事件默认忽略并记录一次开发日志，不抛异常。
8. 客户端仍需用 `AbortController`，abort 时静默返回，不弹网络错误。
9. 非 2xx、body 缺失、流中断分别映射到可读错误。
10. 用固定 SSE fixture 测试事件顺序，至少包含 snapshot 和 error 两条路径。

**涉及文件**

- 修改：`step1-chat/src/types.ts`
- 修改：`step1-chat/src/api/chat.ts`
- 新增：`step1-chat/src/api/chatStructured.test.ts`

**失败路径**

- 把 structured snapshot 又拼成一个字符串，丢失类型。
- `[DONE]` 到来时没有销毁 reader，页面仍显示 streaming。
- 网络 chunk 错位导致一个 SSE event 被截断。
- 未知事件抛出异常，后续 done 收不到。

**验收标准**

- `streamChat()` 行为没有变化。
- snapshot、done、error、abort 和 `[DONE]` 都有明确回调。
- SSE event 被网络切开时仍能正确重组成完整事件。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test src/api/chatStructured.test.ts
npm run typecheck
```

**依赖**：任务 1.5。

**规模**：M，约 60 至 90 分钟。

---

### 任务 1.7：新增结构化消息状态与 Vue 组件

**目的**：把稳定快照真正渲染成用户能看到的表格或代码块。

**具体操作**

1. 不把 `ChatMessage.content` 改成 union，避免破坏现有所有纯文本消息。
2. 为结构化消息增加可选字段，例如：

   ```ts
   interface StructuredMessageState {
     status: "streaming" | "completed" | "incomplete" | "error";
     revision: number;
     snapshot: StructuredSnapshot | null;
     result: StructuredResult | null;
     errorCode?: string;
   }

   interface ChatMessage {
     // 现有字段保持不变
     structured?: StructuredMessageState;
   }
   ```

3. 新增 `StructuredBlock.vue`，只负责根据 snapshot/result 渲染。
4. 表格使用 columns 生成表头，rows 逐行追加，窄屏横向滚动。
5. 代码块使用 `<pre><code>`，首版不引入重型高亮库。
6. 生成中显示稳定状态，不在每个字符上切换 DOM 结构。
7. 收到 snapshot 时只在 revision 更大时替换，不接受旧快照。
8. 收到 done 时保存最终 result 并清空“未完成”标记。
9. 历史消息只加载 final result，不把 partial snapshot 写入 localStorage。
10. 增加 aria-live 或等价状态文本，避免只在视觉上表达生成中。
11. 用 Mock 端点完成一次浏览器手测，记录首个表格行出现的延迟。

**涉及文件**

- 新增：`step1-chat/src/components/StructuredBlock.vue`
- 修改：`step1-chat/src/types.ts`
- 修改：`step1-chat/src/composables/useChat.ts`
- 修改：`step1-chat/src/components/ChatMessageItem.vue`
- 可能修改：`step1-chat/src/App.vue`

**失败路径**

- 把 snapshot 直接 append 到 rows，导致同一行重复。
- done 后再接受迟到 snapshot，完成态被重新改成 streaming。
- 表格单元格过长撑破布局，移动端没有横向滚动。
- localStorage 存入半成品，刷新后出现永久“生成中”消息。
- 切换会话或停止后旧请求的 snapshot 写入新消息。

**验收标准**

- Mock 表格能逐行出现，控制台没有重复 key 警告。
- 窄屏不撑破页面，代码块和长单元格可阅读。
- 刷新后只恢复 completed 的结构化消息。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npm run typecheck
npm run build
npm run dev
```

**依赖**：任务 1.6。

**规模**：M，约 90 至 120 分钟。

**检查点 1**：Mock 纵切完成

- [ ] 固定 chunk 能形成稳定递增 snapshot。
- [ ] 页面能显示逐行表格或递增代码。
- [ ] done 与 partial 状态完全分开。
- [ ] 停止和刷新不会持久化半成品。
- [ ] `npm run typecheck` 和 `npm run build` 通过。
- [ ] 人工复核协议后再接真实模型。

---

### 任务 1.8：接入真实模型的 `stream: true`

**目的**：替换 Mock 原材料来源，但保持 parser、SSE 和 UI 契约不变。

**具体操作**

1. 新建 `server/structured/complete.ts`，不要改现有 ReAct 的 `requestCompletion()`。
2. 根据 `target` 生成明确 system prompt，要求只输出一个 JSON 对象且严格符合 schema。
3. 请求体设置 `stream: true`。
4. 在目标供应商支持时请求 JSON mode，例如 `response_format: { type: "json_object" }`。
5. 用 `ReadableStream` 解析模型 SSE，而不是 `response.text()`。
6. 只提取 `choices[0].delta.content` 中真正要发送给浏览器的 JSON 内容。
7. 忽略空 delta、keep-alive 和其他供应商专属字段。
8. 每次提取到 content 就交给 accumulator。
9. 累计 usage；供应商若只在最后返回 usage，则在结束时统一回调。
10. 记录 model、首 chunk 时间、最后 chunk 时间、chunk 数、字符数和 finish_reason。
11. 加超时和 abort：连接超时、首 chunk 超时和总时长上限分别配置。
12. 在 Mock 与真实模型之间保留同一个 `StructuredChatRequest` 和 SSE 输出。

**涉及文件**

- 新增：`step1-chat/server/structured/complete.ts`
- 修改：`step1-chat/server/structured/streamAccumulator.ts`
- 修改：`step1-chat/server/routes/chatStructured.ts`
- 可能修改：`step1-chat/server/runtimeConfig.ts`

**失败路径**

- 供应商的流式响应不是标准 `data:` 格式。
- JSON mode 返回 400。
- 思考模型把部分内容放在 `reasoning_content`，误拼进 final JSON。
- 代理缓冲响应，服务端看似流式但浏览器一次收到全部内容。
- 429、401、5xx 被统一报成“解析失败”。
- usage 在流式模式下位于最后 chunk，前面从未记录。

**验收标准**

- 真实请求中服务端能观察到多个模型 chunk。
- provider chunk 与发给浏览器的 snapshot 明确分开。
- 至少记录一次真实的首 chunk 时间和总耗时。
- API 错误不会被误报成 JSON parser 错误。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
npx tsx --test server/structured/*.test.ts
npm run typecheck
npm run dev:server
```

**依赖**：检查点 1。

**规模**：M，约 90 至 120 分钟。

---

### 任务 1.9：完成最终校验、降级和可观察性

**目的**：确保“看起来生成出来了”不等于“最终被系统接受”。

**具体操作**

1. accumulator 在结束时保存完整原文。
2. 先执行标准 `JSON.parse`。
3. 如果原文只有一层明确 Markdown JSON fence，执行一次有记录的 `stripJsonFence`。
4. 对解析对象执行 `StructuredResultSchema.safeParse()`。
5. schema 失败时记录 Zod issue path、期望类型和实际类型，不返回完整敏感原文。
6. 对可恢复格式问题最多执行一次修复重试；不能无限重试。
7. 如果供应商不支持 JSON mode，记录 `provider_json_mode_unsupported`，降级为 prompt-only 但最终仍必须通过 schema。
8. 最终成功才发送 `structured_done`。
9. 最终失败发送 `structured_error`，附带最后稳定 revision。
10. 用 `UsageAccumulator` 或结构化专用的等价逻辑写 usage。
11. 检查 `server/usage/types.ts` 是否需要新增 `chat/structured` endpoint 类型。
12. 在 trace 中记录正常、降级、修复和失败路径，但默认不打印完整用户内容。

**涉及文件**

- 修改：`step1-chat/server/structured/streamAccumulator.ts`
- 修改：`step1-chat/server/structured/complete.ts`
- 修改：`step1-chat/server/routes/chatStructured.ts`
- 修改：`step1-chat/server/usage/types.ts`
- 修改：`step1-chat/server/usage/pricing.ts`（仅在需要时）

**失败路径**

- 把 Markdown code fence 当作成功结果直接渲染。
- 修复函数悄悄改变业务数据，却未记录发生过修复。
- 最终 schema 失败仍发送 `structured_done`。
- Zod 错误包含完整 prompt 或大段用户内容。
- usage 记录端点枚举不兼容，旧统计页崩溃。

**验收标准**

- 只有最终 Zod 通过的结果会触发 done。
- 供应商不支持 JSON mode 时有明确 trace 和仍可测试的降级路径。
- usage、错误码和 trace 能把失败定位到请求、解析或 schema 层。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/*.test.ts
npm run typecheck
npm run build
```

**依赖**：任务 1.8。

**规模**：M，约 90 分钟。

---

### 任务 1.10：补齐中止、断网、非法结尾和迟到 chunk

**目的**：真实产品最容易坏在“生成到一半”，而不是正常路径。

**具体操作**

1. 客户端 stop 触发 AbortController，服务端 `res.close` 触发上游模型 signal abort。
2. 中止后保留最后一个稳定 snapshot，状态标记为 incomplete。
3. 网络断在 JSON 字符串中间时，不产生半行 row。
4. 最终没有 finish_reason 或 `[DONE]` 时归类为 `model_stream_interrupted`。
5. 最终文本不是 JSON 时归类为 `invalid_final_json`。
6. JSON 合法但行宽、列数或字段长度错误时归类为 `schema_validation_failed`。
7. 用户停止后，即使旧 Promise 返回 chunk，也拒绝写入 accumulator 和 SSE。
8. 切换模型、清空会话和重试时，旧请求的 token 不能写入新消息。
9. 用户点击重试时创建新的 requestId 和 revision 序列，不复用旧状态。
10. 为每种错误编写后端单元测试、前端事件测试和至少一次手测记录。
11. 配置首 chunk 超时和总时长超时，给出可读错误，不允许无限等待。

**涉及文件**

- 修改：`step1-chat/server/routes/chatStructured.ts`
- 修改：`step1-chat/server/structured/complete.ts`
- 修改：`step1-chat/server/structured/streamAccumulator.ts`
- 修改：`step1-chat/src/api/chat.ts`
- 修改：`step1-chat/src/composables/useChat.ts`
- 新增：`step1-chat/server/structured/failure.test.ts`

**失败路径**

- abort 只取消浏览器读取，不取消上游模型请求。
- 停止后仍写 usage，统计出现幽灵请求。
- 中途失败清空 UI，用户看不到已经生成的内容。
- 半行显示后消失，用户以为页面抖动。
- 重试把旧 revision 414 的快照接到新请求。

**验收标准**

- 停止、断网、坏 JSON 和 schema 错误分别有可识别状态。
- 失败时保留最后一个稳定快照，且不会继续增长。
- 重试后新请求从 revision 重新开始，不接收旧请求事件。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/*.test.ts
npm run typecheck
npm run build
```

**依赖**：任务 1.9。

**规模**：M，约 90 至 120 分钟。

---

### 任务 1.11：完成页面状态和响应式体验

**目的**：把协议正确转化为清楚、稳定、不会跳动过度的界面。

**具体操作**

1. 增加结构化模式选择，至少可选 `table` 和 `code`。
2. 提供三个固定 prompt 快捷示例，但不把说明文字堆进业务界面。
3. 表格列使用稳定布局，长文本可换行或横向滚动，不能撑破气泡。
4. code block 保留换行和空白，空语言使用 `text`。
5. streaming 状态只在消息底部显示一次，不在每个单元格闪动。
6. 错误状态显示简短原因和重试按钮，详细信息只进入 trace 或控制台。
7. incomplete 状态与 error 状态视觉区分。
8. 停止后按钮恢复，用户可以重试，不会重复发送同一请求。
9. 桌面和窄屏都检查表格、长标题、长 URL、中文和英文混合。
10. 检查 loading、empty、partial、done、incomplete、error 六种状态。
11. 不把主要交互做成说明卡片，结构化结果直接进入消息流。

**涉及文件**

- 修改：`step1-chat/src/components/StructuredBlock.vue`
- 修改：`step1-chat/src/components/ChatMessageItem.vue`
- 修改：`step1-chat/src/App.vue`
- 修改：`step1-chat/src/index.css`
- 修改：`step1-chat/src/composables/useChat.ts`

**失败路径**

- 表格每增加一行就改变列宽，整页反复抖动。
- 错误状态把原始堆栈直接给用户。
- 窄屏文字与按钮重叠。
- incomplete 看起来像成功完成。
- 停止和重试可同时点击，产生两个流。

**验收标准**

- 六种状态都能通过固定 fixture 复现。
- 桌面和移动宽度下没有内容溢出父容器。
- 停止后只有一个请求存在，重试只创建新请求。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npm run typecheck
npm run build
npm run dev
```

**依赖**：任务 1.10。

**规模**：M，约 90 分钟。

**检查点 2**：真实流式完成

- [ ] 真实模型至少产生多个服务端 chunk。
- [ ] 表格在最终响应前已出现完整行。
- [ ] 最终 schema 验证通过后才标记完成。
- [ ] 停止、断网、坏 JSON 和 schema 错误都有测试。
- [ ] usage 和 trace 能定位本次请求。
- [ ] 普通 `/api/chat` 代码路径没有被改写。

---

### 任务 1.12：做手写 parser 与 `useObject` 最小对比

**目的**：不是追新依赖，而是用同场景数据决定哪种方案更适合当前项目。

**具体操作**

1. 在独立 `experiments/structured-object-compare/` 建最小页，不接入主应用。
2. 用同一份三行表格 prompt、同一个模型和同一份 schema。
3. 实现或接入 Vercel AI SDK `useObject` 最小示例。
4. 记录安装依赖和 lockfile 变化。
5. 记录两端核心代码行数：
   - SSE 读取。
   - partial parse。
   - schema 校验。
   - 停止。
   - 错误恢复。
   - Vue 状态接入。
6. 记录五项指标：
   - 首个可渲染快照时间。
   - 完成时间。
   - 错误分类能力。
   - 中止和迟到事件处理能力。
   - 对当前 Express SSE 端点的适配成本。
7. 验证 `useObject` 是否要求特定传输协议或 React 生态。
8. 输出结论：继续手写、引入 SDK，或仅借鉴其 partial 解析实现。
9. 实验依赖不能进入主应用 `package.json`，除非明确决定采用。
10. 写明没有选择某个方案的理由，不只写优点。

**涉及文件**

- 新增：`step1-chat/experiments/structured-object-compare/`
- 新增：`step1-chat/docs/structured-output.md`
- 可能新增独立实验 `package.json`
- 不应修改主应用依赖，除非另有明确决策

**失败路径**

- 用不同 prompt、不同 schema 和不同模型比较，数据不可用。
- 只比较代码行数，不比较中止、错误和传输适配。
- 为了 spike 直接改主项目依赖，污染后续回归。
- 把 React hook 的浏览器限制误判为解析算法优劣。

**验收标准**

- 两个方案使用相同输入和 schema。
- 五项指标均有记录。
- 文档给出明确采用结论和适用边界。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npm run typecheck
npm run build
git diff -- package.json package-lock.json
```

**依赖**：检查点 2。

**规模**：M，约 120 分钟。

---

### 任务 1.13：回归三条旧聊天链路并沉淀学习笔记

**目的**：证明新增能力没有把原有应用带坏，并把本次真正学到的知识保留下来。

**具体操作**

1. 回归 `/api/chat` 单 Agent 文本聊天。
2. 回归 `/api/chat/multi` 多 Agent 文本聊天。
3. 回归 `/api/rag/chat` 资料问答和 citations。
4. 回归工具调用、人工确认和 output guard。
5. 回归 usage 汇总，确认新端点枚举显示正确。
6. 运行 typecheck、build、现有 Evals 和结构化专项测试。
7. 写 `docs/structured-output.md`，包含：
   - 四层概念对照。
   - 一份真实 chunk 到 snapshot 的时序。
   - 最终 schema。
   - 六种错误路径。
   - 手写与 SDK 对比结论。
   - 仍未解决的问题。
8. 记录至少一次真实模型的指标：首 chunk、首个 snapshot、done、总耗时、chunk 数。
9. 更新 `tasks/todo.md`，只勾选真实完成的项并附验证结果。
10. 不删除或改写用户已有的 `step1-chat/data/usage-log.json`。

**涉及文件**

- 新增：`step1-chat/docs/structured-output.md`
- 修改：`tasks/todo.md`
- 可能修改：`step1-chat/server/usage/README.md`
- 不主动修改：`step1-chat/data/usage-log.json`

**失败路径**

- 只跑新端点测试，不跑旧 `/api/chat`。
- 没有 API Key 却把真实模型验证标记完成。
- 只看 typecheck 通过，不检查页面和 SSE 时序。
- 把学习笔记写成代码说明，没有记录取舍和失败。

**验收标准**

- 三条旧聊天链路均通过回归。
- 新专项测试与现有 Evals 结果有记录。
- 文档能脱离对话独立解释这项能力。
- 没有误改用户已有的 usage 日志。

**验证**

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
npx tsx --test server/structured/*.test.ts
npm run typecheck
npm run build
npm run eval:chat
npm run eval:multi
```

如果真实模型环境可用：

```bash
cd /Users/ahmin/Downloads/ower/study-ai/step1-chat
test -n "$LLM_API_KEY" && test "$MOCK_MODE" != "1"
npm run eval:chat
npm run eval:multi
```

**依赖**：任务 1.12。

**规模**：M，约 90 分钟。

**最终检查点**

- [ ] 真实模型可逐行生成表格。
- [ ] partial parser 对 10 类 fixture 有测试。
- [ ] 最终结果只有通过 Zod 才显示完成。
- [ ] 停止、断网、坏 JSON、schema 失败均有处理。
- [ ] `/api/chat`、`/api/chat/multi`、`/api/rag/chat` 回归通过。
- [ ] 手写方案与 `useObject` 对比有结论。
- [ ] 文档和学习笔记完成。
- [ ] 等待用户确认后，才决定是否进入整体计划下一项。

---

## 7. 依赖关系

```text
现状基线
  └─ schema + fixtures
       └─ partial parser
            └─ chunk accumulator
                 └─ Mock 结构化 SSE 端点
                      └─ 前端 SSE client
                           └─ Vue 组件与状态
                                └─ 检查点 1
                                     └─ 真实模型 stream
                                          └─ 最终校验/降级/usage
                                               └─ 失败与中止
                                                    └─ 页面状态完善
                                                         └─ 检查点 2
                                                              ├─ useObject 对比
                                                              └─ 回归与文档
```

不能并行或容易冲突的部分：

- schema 与 parser 必须顺序完成。
- accumulator 与 SSE 事件形状必须一致。
- 前端状态与 revision 规则必须一致。
- 真实模型接入前必须先有 Mock 纵切。

可以独立进行的部分：

- 读取现有链路和整理概念笔记。
- 准备 fixtures。
- 编写 `useObject` 实验壳，但正式比较要等同场景端点完成。

---

## 8. 主要风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 把 SSE 分块误当 token stream | 学习结论错误，代码仍假流式 | 任务 1.1 先记录基线，任务 1.8 观察真实 provider chunk |
| 供应商不支持 JSON mode | 请求直接失败 | 能力探测、prompt fallback、最终 schema 仍强制执行 |
| partial parser 输出倒退快照 | UI 闪烁、行重复 | revision、稳定行、content 只增不减 |
| 网络切分不稳定 | 测试偶发失败 | 固定 fixtures，多切分方式，不依赖真实网络做单测 |
| schema 过严导致低成功率 | 用户体验差 | 首版只保留关键限制，统计失败原因后再调整 |
| schema 过松 | 前端仍要处理脏数据 | 列数匹配、长度和数量上限必须有 |
| 中止不传上游 | 模型继续计费 | abort signal 贯穿 fetch、accumulator 和 SSE |
| 把 partial 写进历史 | 刷新后永久半成品 | 只持久化 final result |
| 与现有路由耦合 | 普通聊天回归风险 | 独立端点、独立 complete、独立 client |
| SDK 比较不公平 | 得出错误采用结论 | 相同 prompt、模型、schema 和指标 |

---

## 9. 学习完成后的自测题

全部能不用看资料回答，才算真正掌握：

1. 为什么一个响应是 SSE，不代表模型正在原生流式输出？
2. 为什么 `response_format: json_object` 仍不能让前端直接解析每个 chunk？
3. partial parser 应该对哪些输入返回“暂无新快照”，而不是报错？
4. 为什么 snapshot 需要 revision？
5. 为什么表格最后半行不能进入 rows？
6. 为什么最终 Zod 校验不能替代输出安全检查？
7. 用户停止后，为什么还要让 AbortSignal 传到模型 fetch？
8. 为什么最终 JSON 完整但 rows 单元格数量不一致仍然失败？
9. 结构化结果应该怎样进入历史记录？
10. 什么情况下值得引入 `useObject`，什么情况下手写更合适？

---

## 10. 建议执行方式

后续收到开始指令时，按以下纪律推进：

1. 一次执行一个任务，不跨检查点抢跑。
2. 每个任务先补测试或 fixture，再写实现。
3. 每完成一个任务，列出实际改动文件、测试结果和未解决风险。
4. 到检查点 1 主动暂停，等待确认后再接真实模型。
5. 到最终检查点主动暂停，不自动进入整体计划第 2 项。
6. 如果供应商能力与计划假设不一致，先记录实测，再调整方案。
7. 不修改用户已有的 `step1-chat/data/usage-log.json`。

本计划完成后，下一步通常从“任务 1.1：建立现状基线”开始。
在用户明确下达执行指令前，不开始写业务代码。
