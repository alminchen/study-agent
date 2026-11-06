# server/tools/methods/ — 工具的执行逻辑

> 所属学习阶段：**阶段 2 · 让模型会做事** + **阶段 4 · 知识库检索工具** + **进阶学习第 5 项 · Tool 动态发现**
> 上级说明：[`server/tools/README.md`](../README.md) · 阶段总结：[`docs/dynamic-tool-discovery.md`](../../../docs/dynamic-tool-discovery.md)

## 模块职责

真正干活的代码。入参统一是**模型给的 arguments 原始字符串**，出参统一是结果对象或 `{ error: string }`。

每个工具文件固定三件套：

| 函数 | 作用 | 约定 |
|------|------|------|
| `parseXxxArgs(raw)` | 解析 + 校验 arguments | 返回判别联合 `{ ok: true, args }` / `{ ok: false, error }` |
| `executeXxx(args)` | 业务执行 | 只做业务，不做解析；失败也返回 `{ error }` |
| `runXxx(rawArguments)` | 统一入口 | `findTool().run` 调它；**失败返回 `{ error }`，绝不 throw** |

> **为什么不 throw**：调用方有三处——Guard、聊天回填、MCP server。三处都要把失败变成能展示给用户/模型的一句话。
> 抛异常会把「工具执行失败」和「服务崩了」混成一件事，还得每个调用点各写一遍 try/catch。

## 文件说明

| 文件 | 工具 | 依赖 | 返回 |
|------|------|------|------|
| `weather.ts` | `getWeather` | 无（纯 mock） | `WeatherResult { city, temperature, condition, humidity }` |
| `time.ts` | `getCurrentTime` | 无（系统时钟） | `CurrentTimeResult { iso, formatted, timezone }` |
| `searchDocs.ts` | `searchDocs` | `rag/retrieve` 的 `retrieveForAnswer` | `SearchDocsResult { empty: false, hits[] }` |
| `draftMessage.ts` | `draft_message` | 无（仅打日志） | `DraftMessageResult { ok, simulated, to, body, message }` |

## 各工具要点

### weather.ts

- 天气是 **mock 数据**，不接任何天气 API。
- 非地球城市（火星/月球/太阳等 18 个词）直接返回 `error`，不编造天气。
- 只维护「黑名单」不维护「白名单」：所以广州、杭州这些地球城市不会被误拦。
- 同一城市每次结果相同（按城市名 hash 出温度/天气/湿度），北京、上海有预设值。

### time.ts

- 用本机时区，`Intl.DateTimeFormat().resolvedOptions().timeZone`。
- 空字符串或 `{}` 都算合法入参——本工具无参数。
- 时间由程序生成，不是模型编的。

### searchDocs.ts

- 复用阶段 3 的 `retrieveForAnswer`，分数门槛与标题例外仍留在 `rag/`，这里只负责转成工具结果。
- 返回的 hit 不含 embedding，只给模型能读的 `id/source/title/text/score`。
- **三类失败话术要分清**：
  1. 向量库是空的 → 提示先跑 `npm run rag:ingest`
  2. 有召回但判空（分数低） → 「资料里没有相关内容」
  3. 其它异常 → 「检索服务异常：xxx」

### draftMessage.ts

- 只模拟成功，`simulated: true` 明确告诉模型和前端**没有真的外发**。
- 人工确认发生在 `react/applyToolCalls.ts`：被拒绝时根本不会调到本文件。
- 以后接真实 API 只改 `executeDraftMessage`，确认协议不动。

## 校验方式

解析失败与执行失败都返回 `{ error }`，不抛错。相关测试：
`server/tools/discovery.test.ts`、`server/tools/toolRegistry.test.ts`、
`server/guard/toolCallGuard.test.ts`、`server/mcp/createServer.test.ts`。
