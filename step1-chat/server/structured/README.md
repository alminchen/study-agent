# server/structured/ — Streaming 结构化输出（表格 / 代码块）

> 所属学习阶段：**阶段 1 · Streaming 结构化输出**
> 学习总结：`docs/structured-output.md` · 流程图：`docs/structured-output-flow.svg`
> 拓扑：`docs/project-topology.html` §6c

## 模块职责

让模型的输出**不只是一段文本**，而是可被前端直接渲染的结构化块（表格或代码块），
并且在流式过程中就能给出稳定快照。本模块只关心两件事：

1. 把模型累计吐出的 partial JSON 解析成**可证明稳定**的快照；
2. 把快照、最终结果、错误码和 usage 收敛成一套 SSE 协议。

请求校验、模型流适配、SSE 写出分别落在 `types.ts` / `complete.ts` /
`routes/chatStructured.ts`，本模块内部不向浏览器写 SSE。

## 文件说明

| 文件 | 职责 |
|------|------|
| `types.ts` | 共享数据契约：请求 schema、block schema（table/code 判别联合）、最终结果、中间快照、错误码、SSE 事件、长度上限 |
| `complete.ts` | 真实模型流适配层：OpenAI 兼容 provider 的 SSE、超时、abort、usage、错误分类（**不解析业务 JSON**） |
| `parsePartialJson.ts` | partial JSON 解析器：区分 complete / incomplete / invalid，只让「已证明稳定」的字段进入快照 |
| `streamAccumulator.ts` | 单次模型响应的累积状态机：streaming → completed / failed / aborted，路由层只按它的结果写 SSE |
| `mockStream.ts` | 固定 fixture 回放器：只替换文本 chunk 来源，后续仍走真实 accumulator / parser / SSE 协议 |
| `fixtures/partial-json.ts` | parser 的固定输入集（10 个 fixture），Mock 回放与 parser 验证共用同一份数据 |

入口路由：[`server/routes/chatStructured.ts`](../routes/chatStructured.ts)。

## 核心约定

### 1. 快照 vs 最终结果

| 类型 | 用途 | 必过校验 |
|------|------|---------|
| `StructuredSnapshot` | 生成中的 UI，**不写入最终历史** | block 约束 + 行宽一致 |
| `StructuredResult` | 模型结束后使用 | 完整 schema + 行宽一致 |

两者共用同一套 block 约束，快照只多一个 `revision`（单调递增，前端只接受更大的值）。

### 2. 解析三态（token 级）

parser 内部为每个 token 标三种状态：

- `complete`：该 token 自身已闭合（字符串已收尾、数值已结束等）；
- `incomplete`：还没到齐，后续 chunk 仍可能让它合法；
- `invalid`：按 JSON 语法已经不可能恢复。

注意 `complete` 只表示**该 token**闭合，不代表整个根对象已完成 —— 根对象是否
可提交由快照规则决定。

`parseStructuredChunk` 返回 `{ state, nextSnapshot, diagnostic }`：只有真正稳定
增长时 `nextSnapshot` 才非 null，parser 本身**不产生 UI 数据**。

### 3. 行宽一致

表格的 `rows` 在 block 层校验，每行宽度必须等于 `columns` 长度，否则报
`schema_validation_failed`（快照与最终结果都会拦）。

## 长度上限

`STRUCTURED_LIMITS`（`types.ts`）集中定义，避免单个结构化结果无限增长：

| 字段 | 上限 |
|------|------|
| `titleMaxChars` | 80 |
| `tableColumnsMax` | 8 |
| `tableColumnNameMaxChars` | 120 |
| `tableRowsMax` | 50 |
| `tableCellMaxChars` | 2000 |
| `codeLanguageMaxChars` | 32 |
| `codeContentMaxChars` | 20000 |
| `requestMessagesMax` | 100 |
| `requestMessageContentMaxChars` | 20000 |
| `modelMaxChars` | 120 |

协议版本号 `STRUCTURED_SCHEMA_VERSION = 1`；字段语义变化时应升级。

## SSE 事件

| 事件 | 作用 |
|------|------|
| `structured_start` | 请求开始，带 `requestId` 与 `schemaVersion` |
| `structured_delta` | 只报告接收进度（sequence / receivedChars），**不携带模型原始 JSON** |
| `structured_snapshot` | 稳定快照，`revision` 单调递增 —— 前端唯一的增量渲染源 |
| `structured_done` | 最终结果，必须已通过 `StructuredResultSchema` |
| `structured_error` | 失败，带 `code` / `retryable` / `lastRevision`（允许保留最后可安全展示的快照） |
| `usage` | token 统计，endpoint 固定 `chat/structured` |
| `memory_injected` | 本轮注入了哪几条长期记忆（与其它链路同形状，只进过程面板） |
| `memory_extracted` | 本轮抽取并落盘的记忆条目 |
| `memory_failed` | 记忆链路某一步失败（不影响结构化回复） |

## 错误码

`model_request_failed` · `model_stream_interrupted` · `partial_parse_failed` ·
`invalid_final_json` · `schema_validation_failed` ·
`provider_json_mode_unsupported`

前端可稳定分支处理这些码；`message` 只用于诊断，不参与业务判断。

## 数据流

```
POST /api/chat/structured
  → StructuredChatRequestSchema 校验
  → 长期记忆：路由层检索一次 → memory_injected?
      └─ 记忆块追加到 system prompt 末尾（schema 约束在前、记忆在后）
  → streamStructuredCompletion（真实模型）/ streamMockStructuredChunks（Mock）
  → StructuredStreamAccumulator.append(chunk)
      └─ parseStructuredChunk → 稳定才推进 revision → structured_snapshot
  → finish()：最终结果过 StructuredResultSchema
      ├─ 通过 → structured_done
      └─ 不通过 → structured_error（invalid_final_json / schema_validation_failed）
  → 长期记忆抽取（旁路）：只用最后一条用户消息，不带生成的 JSON
  → usage → [DONE]
```

## Mock 与 fixture

`fixtures/partial-json.ts` 里的 10 个 fixture 同时声明原始累计文本、预期快照数量
和最终是否合法，`mockStream.ts` 与 parser 验证都从这里取数据 —— **不维护两套
不一致的样例**。

fixture id：`complete-table` · `complete-code` · `half-object` ·
`unterminated-chinese-string` · `escaped-backslashes` ·
`table-columns-and-first-row` · `table-last-row-unclosed` ·
`code-newline-and-backtick` · `missing-block-kind` · `final-column-mismatch`

Mock 的切点从 fixture 内容反推（如表格在列骨架、第一行、第二行完成时分别成快照），
避免另抄一份完整 JSON。

## API 端点

`POST /api/chat/structured`（`server/routes/chatStructured.ts`）

请求体由 `StructuredChatRequestSchema` 定义；`target` 取 `table` 或 `code`。

可选字段 `userId` / `allowMemory` 用来接入跨会话记忆：
关掉时前端**连 userId 一起不带**，服务端零检索、零抽取。

## 长期记忆的口径

- **注入点**：`complete.ts` 的 `buildSystemPrompt` **末尾**追加「## 用户长期记忆」
  小节。schema 约束在前、记忆在后；没有记忆时 system prompt 与改造前逐字一致。
- **边界**：记忆只能影响生成内容的**取值**，不得改变 JSON 的形状与字段。
- **抽取点**：`structured_done` 之后触发，**只用最后一条用户消息**，
  且**不带最终回答** —— 生成的 JSON / 表格是数据，不是用户事实。

## 边界说明

- `complete.ts` **不复用** ReAct 的非流式 complete，两条链路互不影响。
- provider 不支持 JSON mode 时降级并报 `provider_json_mode_unsupported`。
- 客户端断连后终止上游请求，并拒绝迟到的 chunk。
- 结构化快照只用于生成中渲染，**不进最终聊天历史**。
