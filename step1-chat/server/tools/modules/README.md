# server/tools/modules/ — 一个目录一个工具

> 所属学习阶段：**进阶学习第 5 项 · Tool 动态发现**
> 上级说明：[`server/tools/README.md`](../README.md) · 阶段总结：[`docs/dynamic-tool-discovery.md`](../../../docs/dynamic-tool-discovery.md)

## 模块职责

这是阶段 5 的新增层。每个子目录导出一个 `tool: ToolModule`，把三样东西粘在一起：

- `schema` —— 给模型看的 Function Calling 定义
- `run` —— 给服务端跑的执行函数
- 元数据 —— `tags` / `risk` / 是否进 MCP

`discover.ts` 在启动时扫描本目录，为每个 `*/index.ts` 建一个工具并校验；
通过后进入注册表，Guard / MCP / Chat / Worker 全部从注册表派生，**不再各抄一份白名单**。

## 目录结构

```
modules/
├── getWeather/index.ts     — getWeather     · realtime · read   · 进 MCP
├── getCurrentTime/index.ts — getCurrentTime · realtime · read   · 进 MCP
├── searchDocs/index.ts     — searchDocs     · kb       · read   · 进 MCP
└── draft_message/index.ts  — draft_message  · action   · confirm · 不进 MCP
```

> 扫描顺序 = 目录名字母序（`draft_message` → `getCurrentTime` → `getWeather` → `searchDocs`）。
> 顺序稳定，但不依赖它做逻辑判断。

## ToolModule 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 工具名，必须与 `schema.function.name` 一致，全局唯一 |
| `schema` | ✅ | [`schemas/`](../schemas/README.md) 里的 Function Calling 定义 |
| `run` | ✅ | [`methods/`](../methods/README.md) 里的 `runXxx`，入参仍是原始 JSON 字符串 |
| `tags` | ✅ | `realtime` / `kb` / `action`，供 Worker 过滤 |
| `risk` | ✅ | `read`（只读）或 `confirm`（执行前需人工确认） |
| `includeInDefaultChat` | — | 未勾选「搜索知识库」时是否仍默认暴露给单 Agent |
| `mcp.expose` | — | 是否挂到 MCP server |
| `mcp.inputSchema` | — | MCP 入参（zod raw shape），缺省视为无参数 |

四个模块的实际取值：

| 模块 | tags | risk | includeInDefaultChat | mcp.expose | mcp.inputSchema |
|------|------|------|----------------------|------------|-----------------|
| `getWeather` | `realtime` | `read` | 是 | 是 | `{ city: z.string() }` |
| `getCurrentTime` | `realtime` | `read` | 是 | 是 | `{}` |
| `searchDocs` | `kb` | `read` | 否 | 是 | `{ question: z.string() }` |
| `draft_message` | `action` | `confirm` | 是 | **否** | — |

## 两套 schema，别混

| | `schema.function.parameters` | `mcp.inputSchema` |
|---|---|---|
| 格式 | JSON Schema | zod raw shape |
| 给谁 | 模型（Function Calling） | MCP 协议客户端 |
| 在哪 | [`schemas/`](../schemas/README.md) | 本目录模块的 `mcp` 字段 |

两者格式不同，**不能互相替代**。漏写 `mcp.inputSchema` 的表现是：MCP 端收不到入参，报「缺少参数 city」。

## 启动期校验（不通过就启动失败）

- 模块必须导出 `tool`
- `name` 与 `schema.function.name` 一致
- `run` 是函数
- `tags` 合法且不重复
- `risk` 合法
- 工具名全局不重复

任一条不满足 → 启动直接抛错并打印模块名，**不会静默跳过**。

## 新增一个工具

1. 新建 `modules/<name>/index.ts`，导出 `export const tool: ToolModule`
2. 在 [`schemas/`](../schemas/README.md) 写 schema、在 [`methods/`](../methods/README.md) 写实现
3. 在模块里粘合三者，声明 `name` / `tags` / `risk`，需要对外暴露 MCP 就写 `mcp`
4. 跑测试：`npx tsx --test server/tools/*.test.ts server/guard/toolCallGuard.test.ts server/mcp/createServer.test.ts`

**不用再改**：`tools/index.ts`、`guard/toolCallGuard.ts` 的工具白名单、`mcp/createServer.ts`、Worker 的工具名列表——全部从注册表派生。
