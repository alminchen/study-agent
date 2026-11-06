# 阶段 1：Streaming 结构化输出学习总结

> 记录日期：2026-10-30
>
> 全链路流程图：[structured-output-flow.svg](./structured-output-flow.svg)
>
> 流程索引：[flows-index.md](./flows-index.md) · [flows-index.html](./flows-index.html#structured-output)
>
> 项目拓扑：[project-topology.html §6c](./project-topology.html#structured)
>
> 当前状态：代码静态审计和文档已完成。按用户约束，本轮未运行
> dev、build、typecheck、Evals、专项测试或浏览器验证，也没有调用真实模型。
> 因此本文中的耗时、首 chunk、首个 snapshot 和运行回归结论均不冒充实测结果。

## 0. 为什么学习这条路径

普通文本流解决的是“回答如何逐字出现”。结构化输出解决的是另一个问题：
程序如何从流式回答中持续得到可以安全渲染、最终可以被业务代码直接消费的对象。

如果没有这一层，前端通常只能先接收一段字符串，等模型结束后再尝试
`JSON.parse()`。生成过程中页面只能显示原始文本，模型一旦输出半截 JSON、
Markdown fence、错误字段或错误类型，问题只能在最后暴露。

本阶段的目标不是只接一个 JSON 接口，而是把整条链路拆开并分别建立约束：

| 学习步骤 | 要解决的问题 | 本项目对应实现 |
| --- | --- | --- |
| 1. 理解模型 token stream | 模型是否边生成边返回 | OpenAI 兼容 `chat/completions` 的 `stream: true` |
| 2. 理解服务端 SSE | 服务端如何把过程持续交给浏览器 | `POST /api/chat/structured` 写 `data: ...` 事件 |
| 3. 定义请求契约 | 浏览器能传什么、不能传什么 | `StructuredChatRequestSchema` |
| 4. 累积不完整文本 | 网络 chunk 不等于完整 JSON | `StructuredStreamAccumulator.append()` |
| 5. 生成稳定快照 | 未完成内容如何安全展示 | `parseStructuredChunk()` + `StructuredSnapshotSchema` |
| 6. 最终校验结果 | 什么时候才能进入业务历史 | `JSON.parse()` + 单层 fence 修复 + `StructuredResultSchema` |
| 7. 管理 UI、错误和观测 | 停止、失败、迟到 chunk 如何收尾 | revision 去重、不可逆终态、usage、LangSmith |

学完后应能解释并实现三件事：

- 生成中只展示已经闭合且通过快照 schema 的字段，不直接渲染原始 JSON 片段。
- 模型结束后只有通过最终 schema 的对象才能进入完成态和长期历史。
- 中止、网络中断、最终 JSON 错误和 schema 错误分别走明确状态，不互相覆盖。

## 1. 这项能力解决什么问题

普通聊天流返回的是文本增量。前端可以不断拼接字符串，但它无法仅凭某个网络
chunk 得到可信的表格、代码块或业务对象。

Streaming 结构化输出把链路拆成四层：

| 层级 | 解决的问题 | 本项目实现 |
| --- | --- | --- |
| 模型 token stream | 模型是否边生成边返回 | 供应商返回 OpenAI 兼容的 `chat.completion.chunk` |
| 服务端 SSE | 服务端如何持续通知浏览器 | `/api/chat/structured` 按 `data: ...\n\n` 写事件 |
| 结构化校验 | 最终结果能否被程序直接消费 | Zod 校验 `schemaVersion` 与 `block` |
| 稳定快照 | 未完成结果能否安全展示 | 累积 chunk、partial parse、发送单调递增的 snapshot |

四个概念不能互相替代：

- 有 SSE 不代表模型原生流式。
- 模型流式返回不代表每个网络 chunk 都是完整 JSON。
- JSON mode 只改善最终 JSON 概率，不保证中间片段可 `JSON.parse()`。
- Zod 通过只证明形状正确，不证明内容事实正确。

## 2. 一次 chunk 到 snapshot 的过程

### 2.1 数据流

```text
模型 chunk
  -> StructuredStreamAccumulator.append()
  -> 累积完整文本
  -> parseStructuredChunk()
  -> 只提取已经闭合的字段
  -> StructuredSnapshotSchema 校验
  -> revision 单调增长
  -> structured_snapshot SSE
  -> Vue 更新 StructuredMessageState
  -> 模型结束后 StructuredResultSchema 最终校验
  -> structured_done SSE
```

网络 chunk 只是原材料。前端真正渲染的是服务端证明过稳定的 snapshot，不是
原始 JSON 片段。

### 2.2 固定 fixture 的时序

现有 mock 将同一份两行表格 fixture 切成三段：

| 阶段 | 累积内容 | 页面可得到的状态 |
| --- | --- | --- |
| chunk 1 | 标题和 columns 已完整，rows 尚未开始 | 表头快照，0 行 |
| chunk 2 | 第一行已闭合 | 表头快照，1 行 |
| chunk 3 | 第二行及根对象已闭合 | 表头快照，2 行 |
| finish | 完整 JSON 通过最终 schema | `structured_done`，完成态 |

最后半行不会进入 snapshot。表格只收录已经闭合、且列数与 columns 一致的行。

### 2.3 真实模型指标

| 指标 | 结果 |
| --- | --- |
| 首 chunk 时间 | 未测 |
| 首个可渲染 snapshot 时间 | 未测 |
| done 时间 | 未测 |
| 总耗时 | 未测 |
| chunk 数 | 未测 |

没有真实运行数据时，上述字段保持“未测”，不能用固定间隔的 mock 时间代替。

## 3. 最终数据契约

最终结果只有通过完整 Zod schema 后才能进入完成态：

```json
{
  "schemaVersion": 1,
  "block": {
    "kind": "table",
    "title": "模型对比",
    "columns": ["模型", "优势"],
    "rows": [["A", "速度快"]]
  }
}
```

也支持代码块：

```json
{
  "schemaVersion": 1,
  "block": {
    "kind": "code",
    "title": "常量示例",
    "language": "ts",
    "content": "const answer = 42;"
  }
}
```

最终 schema 位于 `server/structured/types.ts`，主要约束包括：

- `schemaVersion` 必须为 `1`。
- `block.kind` 只能是 `table` 或 `code`。
- 表格至少 1 列、最多 8 列，最多 50 行。
- 每一行的单元格数必须与 columns 数一致。
- 标题、语言名和单元格都有长度上限。
- 对象使用 strict 校验，不允许额外字段。

生成中的 snapshot 额外带 `revision`，但不写入长期聊天历史。

## 4. SSE 事件

| 事件 | 用途 | 是否直接渲染 |
| --- | --- | --- |
| `structured_start` | 声明请求进入结构化模式 | 只表示 loading |
| `structured_delta` | 报告累计接收字符数 | 否 |
| `structured_snapshot` | 发送稳定中间态 | 是 |
| `structured_done` | 发送最终校验通过的对象 | 是 |
| `structured_error` | 发送可分类错误 | 是 |
| `usage` | 沿用现有 token 用量面板 | 否 |
| `[DONE]` | 关闭 SSE 读取循环 | 否 |

前端只接受更大的 `revision`。`structured_delta.receivedChars > 0` 不能用来
推断页面已经有可展示内容。

## 5. 六种错误路径

| code | 当前处理 |
| --- | --- |
| `model_request_failed` | HTTP 请求失败；401/403 不可重试，429/5xx 可重试 |
| `model_stream_interrupted` | 流未收到完成标记或读取中断，可重试 |
| `partial_parse_failed` | 保留为错误分类；当前 parser 先记录诊断并等待更多 chunk，不立即终止 |
| `invalid_final_json` | 模型结束后仍无法解析 JSON，可重试 |
| `schema_validation_failed` | JSON 合法但不符合最终 schema，可重试 |
| `provider_json_mode_unsupported` | 第一次请求命中不支持 JSON mode 时，自动降级为 prompt-only 重试 |

停止请求时保留最后稳定 snapshot，并将前端消息标为 `incomplete`。迟到 chunk
会在 accumulator 终态被拒绝，不能把完成或中止状态改回 streaming。

页面视觉状态共有六种：`empty`、`loading`、`partial`、`done`、
`incomplete`、`error`。

## 6. 旧链路静态回归审计

本轮没有运行请求，因此以下只能称为静态审计，不是运行回归通过。

| 旧链路 | 静态检查结果 |
| --- | --- |
| `POST /api/chat` | 仍独立注册；单 Agent ReAct、工具、确认会话和 output Guard 入口保留 |
| `POST /api/chat/multi` | 仍独立注册；Supervisor、Workers、Aggregate、确认和 output Guard 入口保留 |
| `POST /api/rag/chat` | 仍独立注册；检索、citations 元数据、tool Guard 和 output Guard 入口保留 |
| `POST /api/chat/confirm` | 仍由单 Agent 和多 Agent 共用 |
| `GET /api/usage` | `chat/structured` 已包含在 endpoint 类型、记录和按 endpoint 汇总中 |

结构化能力使用独立入口，没有把普通聊天改成结构化协议。

## 7. 手写方案与 useObject 的边界

Vercel AI SDK 官方文档当前说明 `useObject` 可用于 React、Vue、Svelte 和
SolidJS，因此“只能在 React 使用”不是准确结论。Vue 对应包为
`@ai-sdk/vue`。

官方资料：

- https://ai-sdk.dev/docs/ai-sdk-ui/object-generation
- https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-object
- https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol

`useObject` 消费的是“表示 JSON 对象的 chunked text stream”，并提供
`object`、`error`、`isLoading`、`stop`、`clear`、`onFinish`。它能减少客户端
partial parse 和 Vue ref 状态接入代码，但不能直接替代本项目当前的业务 SSE：

- 当前 SSE 同时承载 requestId、revision、错误分类、usage 和完成语义。
- `useObject` 默认关注对象文本流和最终 schema 校验，不包含本项目的业务错误码、
  trace、token 统计和迟到 chunk 状态机。
- 接入时需要增加一个文本 JSON 流端点，或自定义 fetch/transport 适配现有事件。

暂定结论：主链路继续保留手写实现；`useObject` 只适合做隔离 spike，或借鉴其
partial parser 与 hook 状态设计。这个结论来自官方文档和静态代码审计，任务
1.12 的最小实验与实测对比尚未完成，不能据此宣称 SDK 已被实测评优。

## 8. 实现地图

这张表把概念落到当前项目文件，避免把学习笔记写成脱离项目的通用介绍。

| 文件 | 责任 | 不应该负责什么 |
| --- | --- | --- |
| `server/structured/types.ts` | 请求、最终结果、snapshot、错误码和 SSE 事件的共享契约 | 不发起模型请求，不维护 UI 状态 |
| `server/routes/chatStructured.ts` | HTTP 校验、SSE、Mock/真实分支、usage、trace 和终态收口 | 不手写 partial JSON 语法 |
| `server/structured/complete.ts` | 解析 provider SSE、超时、abort、usage 和错误分类 | 不判断业务 block 是否合法 |
| `server/structured/streamAccumulator.ts` | 单次模型流的不可逆状态机、最终 JSON/schema 校验 | 不向浏览器写 SSE |
| `server/structured/parsePartialJson.ts` | 从累计文本中只提取已经闭合的字段 | 不决定最终完成态 |
| `server/structured/mockStream.ts` | 提供可重复的 chunk 序列，验证同一套状态机 | 不替代真实模型兼容性测试 |
| `src/api/chat.ts` | 浏览器读取 SSE、识别 snapshot/done/error、等待 `[DONE]` | 不决定最终业务历史 |
| `src/composables/useChat.ts` | 消息状态、revision 去重、完成/中止/错误收尾、持久化规则 | 不解析模型原始 JSON |
| `src/components/StructuredBlock.vue` | 把稳定 snapshot 或最终 result 渲染成表格/代码 | 不推断请求状态 |
| `src/components/ChatMessageItem.vue` | 把内部状态映射成用户可见状态和重试入口 | 不改变协议事件 |

模块级说明：[`server/structured/README.md`](../server/structured/README.md)（协议、状态机、数据流与错误码）。

关键分层可以概括为：

```text
HTTP 请求契约
  -> provider 文本流
  -> accumulator 状态机
  -> partial parser
  -> snapshot 契约
  -> SSE 协议
  -> Vue 状态机
  -> 纯展示组件
  -> 最终历史
```

每一层只消费上一层已经证明过的数据，避免浏览器重新猜测模型输出的形状。

## 9. 阶段学习总结

### 9.1 设计是如何收敛的

| 阶段 | 最初问题 | 收敛后的做法 |
| --- | --- | --- |
| 只做文本流 | 生成过程有反馈，但业务层无法消费 | 增加独立的 `/api/chat/structured` |
| 直接解析网络 chunk | chunk 可能停在任何字符位置，`JSON.parse()` 不可靠 | 累积文本，再由 partial parser 识别完整 token |
| 每次解析都发 UI | 未闭合字段和重复内容会闪烁、回退 | 只有通过 snapshot schema 且 revision 增长才发送 |
| 生成中当作最终数据 | 半成品可能污染历史或下一轮上下文 | partial snapshot 只留在内存，最终 result 才持久化 |
| 用一个错误覆盖所有失败 | 用户无法区分重试、格式错误和 schema 错误 | 六类稳定错误码 + `lastRevision` |
| 只处理正常完成 | 停止、断流、迟到 chunk 可能改写终态 | accumulator 使用不可逆终态，前端只接受更高 revision |
| 只验证 JSON 语法 | 合法 JSON 仍可能字段错误、类型错误或表格列宽不一致 | 最终统一通过 strict Zod schema |
| 只看浏览器结果 | 失败时缺少 provider、usage 和 trace 证据 | usage 独立记录，LangSmith 根 span 与 LLM span 分开 |

### 9.2 最关键的工程结论

- **SSE 不是模型流式本身。** SSE 是服务端到浏览器的传输协议，provider 流是另一段链路，中间必须经过服务端状态机。
- **JSON mode 不等于 partial JSON。** 它只提高最终 JSON 的概率，不保证任意中间网络 chunk 都能解析。
- **delta 和 snapshot 是两种语义。** `structured_delta` 只说明收到了多少字符；只有 `structured_snapshot` 可以驱动 UI。
- **revision 是 UI 顺序保护，不是模型内容版本。** 它阻止重复、迟到和乱序 snapshot 把页面改回旧状态。
- **快照通过不等于最终通过。** 快照只使用当前已经闭合的字段，最终仍要重新验证完整根对象、额外字段和跨字段约束。
- **状态机必须单向。** `streaming` 只能进入 `completed`、`failed` 或 `aborted`，终态不能恢复为 streaming。
- **中止不是错误。** 用户停止时保留最后一个稳定 snapshot，消息标记为 `incomplete`；不应被晚到的 provider 错误覆盖。
- **最终修复必须克制。** 当前只允许剥离一层 JSON Markdown fence，不递归补全、不猜测缺字段，避免把错误输出“修”成看似合法的数据。
- **观测数据与业务数据分开。** usage 最多记录一次，trace 只保留短预览和诊断，不把完整 prompt 或模型原文写入 span。
- **Mock 和真实模型共用收尾。** Mock 只替换 chunk 来源，partial parse、snapshot、最终 schema、SSE 和 UI 仍走同一条主链。

### 9.3 认知变化

| 容易产生的误解 | 学完后的准确认识 |
| --- | --- |
| 接了 SSE 就等于支持结构化流式 | SSE 只负责传事件，结构化语义来自事件契约和状态机 |
| 模型输出 JSON mode 后前端可以边收边 `JSON.parse()` | 中间文本可能不完整，必须有 partial parser 或等价能力 |
| 有 partial object 就应该立即渲染 | 只有已经闭合、满足 snapshot schema 的字段才适合渲染 |
| 最终 JSON 合法就可以展示 | 还必须通过 strict schema 和跨字段约束 |
| 用户停止后继续等待最终结果 | 停止应立即取消上游，并冻结最后一个稳定快照 |
| 客户端能根据 `receivedChars` 判断有没有内容 | 字符数只表示接收进度，不代表存在可渲染 snapshot |
| 手写实现只是“重复造轮子” | 业务 SSE 同时承载 revision、错误码、usage、trace 和终态规则，需要判断 SDK 是否真的覆盖这些边界 |

### 9.4 本阶段应该能够独立完成的事

- 说明模型 token stream、服务端 SSE、结构化校验和稳定 snapshot 四层的区别。
- 从一段停在任意位置的 JSON 文本判断哪些字段已经闭合，哪些内容不能渲染。
- 设计 `structured_start`、`structured_snapshot`、`structured_done`、`structured_error` 和 `[DONE]` 的最小协议。
- 解释为什么前端只接受更大的 revision，以及为什么终态不能被迟到事件覆盖。
- 区分 `invalid_final_json`、`schema_validation_failed` 和 `model_stream_interrupted` 的处理边界。
- 在不修改普通聊天、多 Agent 和 RAG 主链的前提下，新增一个独立结构化端点。
- 说明手写链路与 `useObject` 的职责差异，而不是只比较 API 名称。

### 9.5 下一阶段可执行清单

以下步骤尚未执行，需要后续明确授权：

1. 在允许启动服务的窗口内，先跑一次 Mock 手工回归，记录 start、首个 snapshot、done、错误和停止路径。
2. 在允许调用真实模型的窗口内，分别用 table 和 code 记录首 chunk、首个 snapshot、done 和总耗时。
3. 对至少一个 OpenAI 兼容 provider 验证 JSON mode、usage 末 chunk、断流和 `[DONE]` 行为。
4. 做一次 `useObject` 隔离 spike，只比较 partial parse、状态管理、业务错误码和 usage 接入成本。
5. 经明确授权后，再设计最小回归用例，覆盖 revision 去重、停止保留快照、最终 schema 失败和迟到 chunk。
6. 补测旧 `/api/chat`、`/api/chat/multi`、`/api/rag/chat`，确认新端点没有改变旧链路行为。

## 10. 仍未解决的问题

- 没有真实模型的首 chunk、首个 snapshot、done 和总耗时数据。
- 没有运行 `/api/chat`、`/api/chat/multi`、`/api/rag/chat` 回归。
- 没有运行 typecheck、build、Evals 或浏览器验证。
- 结构化专项测试文件已按用户要求删除，因此当前没有可执行的专项测试套件。
- 任务 1.12 的 `useObject` 隔离实验尚未落地，手写与 SDK 的代码量对比未实测。
- 不同供应商对 JSON mode、usage 末 chunk 和错误响应的兼容性仍需真实环境验证。
- 首 chunk 超时、总时长超时、断网和迟到 chunk 当前只有代码路径，缺少本轮运行证据。

