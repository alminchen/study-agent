# server/tools/ — 工具定义与执行

> 所属学习阶段：**阶段 2 · 让模型会做事** + **阶段 4 · 知识库检索工具** + **进阶学习第 5 项 · Tool 动态发现**
> 学习计划文档：`stage4-kb-search-tool-learning-plan.md` · 阶段总结：[`docs/dynamic-tool-discovery.md`](../../docs/dynamic-tool-discovery.md)

## 模块职责

定义工具的 schema（给模型看）和执行方法（给服务端跑），并在启动时扫描 `modules/` 生成**唯一注册表**，其它地方（Guard / MCP / Chat / Worker）都从注册表派生，不再各抄一份。

## 目录结构

```
tools/
├── index.ts          — 启动时 discoverTools() → createRegistry() → 对外 re-export
├── types.ts          — ToolSchema / ToolDefinition / ToolModule / TOOL_TAGS / ToolRisk
├── discover.ts       — 固定目录扫描 modules/*/index.ts + 启动期校验
├── registry.ts       — createRegistry()：派生 findTool / listTools / listToolNames /
│                       toolSchemas / toolSchemasForChat / toolsWithTags / toolsWithMcp /
│                       isToolRequiringConfirm
├── modules/          — 每个子目录一个工具，导出 export const tool: ToolModule
│   ├── getWeather/index.ts      — tags: realtime · risk: read · MCP 暴露
│   ├── getCurrentTime/index.ts  — tags: realtime · risk: read · MCP 暴露
│   ├── searchDocs/index.ts      — tags: kb · risk: read · MCP 暴露
│   └── draft_message/index.ts   — tags: action · risk: confirm · 不进 MCP
├── schemas/          — 给模型看的 Function Calling schema
│   ├── weather.ts
│   ├── time.ts
│   ├── searchDocs.ts
│   └── draftMessage.ts
├── methods/          — 实际执行逻辑
│   ├── weather.ts    — getWeather（mock 天气数据）
│   ├── time.ts       — getCurrentTime（真实时间）
│   ├── searchDocs.ts — searchDocs（调用 RAG retrieve）
│   └── draftMessage.ts — draftMessage（模拟发送，需人工确认）
├── discovery.test.ts    — 发现与校验的正/负向测试
└── toolRegistry.test.ts — 注册表派生行为测试
```

三个子目录各有自己的说明：

- [`schemas/README.md`](schemas/README.md) — 给模型看的 Function Calling 定义怎么写
- [`methods/README.md`](methods/README.md) — 执行逻辑的 parse / execute / run 三件套约定
- [`modules/README.md`](modules/README.md) — ToolModule 字段、启动期校验、新增工具步骤

## 新增工具步骤（当前：动态发现，只需 1 个目录）

1. 新建 `modules/<name>/index.ts`，导出 `export const tool: ToolModule`
2. 在里面粘合已有的 `schemas/*` 与 `methods/*`（`schema` + `run`）
3. 声明元数据：`name`（须等于 `schema.function.name`）、`tags`、`risk`、可选 `mcp.expose`
4. 跑测试：`npx tsx --test server/tools/*.test.ts server/guard/toolCallGuard.test.ts server/mcp/createServer.test.ts`

**不用再改**：`tools/index.ts`、`guard/toolCallGuard.ts` 白名单、`mcp/createServer.ts`、Worker 的工具名列表——这些都从注册表派生。

### ToolModule 约定

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 工具名，必须与 `schema.function.name` 一致，全局唯一 |
| `schema` | ✅ | `schemas/` 里的 Function Calling 定义 |
| `run` | ✅ | `methods/` 里的执行函数，入参仍是原始 JSON 字符串 |
| `tags` | ✅ | `realtime` / `kb` / `action` 之一或多个，供 Worker 过滤 |
| `risk` | ✅ | `read`（只读）或 `confirm`（执行前需人工确认） |
| `includeInDefaultChat` | — | 未勾选「搜索知识库」时是否仍默认暴露给单 Agent |
| `mcp.expose` | — | 是否挂到 MCP server（`draft_message` 不暴露） |
| `mcp.inputSchema` | — | MCP 入参（zod raw shape）。缺省视为无参数，注册时补空 shape |

> `schema.function.parameters` 是给模型看的 JSON Schema；`mcp.inputSchema` 是给 MCP 协议用的
> zod shape。两者格式不同，不能互相替代——漏写会让 MCP 端收不到入参（表现为「缺少参数 xxx」）。

### 启动期校验（不通过就启动失败）

- 模块必须导出 `tool`
- `name === schema.function.name`
- `run` 是函数
- `tags` 合法且不重复
- `risk` 合法
- 工具名全局不重复

任一条不满足 → 启动直接抛错并打印模块名，**不会静默跳过**。

> 设计说明与「为什么这样做」：  
> [`docs/dynamic-tool-discovery.md`](../../docs/dynamic-tool-discovery.md) · [`docs/dynamic-tool-discovery-flow.svg`](../../docs/dynamic-tool-discovery-flow.svg)
