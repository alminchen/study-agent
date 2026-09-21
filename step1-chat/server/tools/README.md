# server/tools/ — 工具定义与执行

> 所属学习阶段：**阶段 2 · 让模型会做事** + **阶段 4 · 知识库检索工具**
> 学习计划文档：`stage4-kb-search-tool-learning-plan.md`

## 模块职责

定义工具的 schema（给模型看）和执行方法（给服务端跑），统一注册管理。

## 目录结构

```
tools/
├── index.ts          — 工具注册表（name → schema + run）
├── types.ts          — ToolDefinition 类型
├── schemas/          — 给模型看的 Function Calling schema
│   ├── weather.ts
│   ├── time.ts
│   └── searchDocs.ts
└── methods/          — 实际执行逻辑
    ├── weather.ts    — getWeather（mock 天气数据）
    ├── time.ts       — getCurrentTime（真实时间）
    └── searchDocs.ts — searchDocs（调用 RAG retrieve）
```

## 新增工具步骤（当前：静态注册表）

1. `schemas/` 加一份 Function Calling schema
2. `methods/` 加一份执行函数
3. `index.ts` 注册 name → schema + run
4. 同步改：`guard/toolCallGuard.ts` 白名单、`mcp/createServer.ts`；若给 Worker 用还要改名字列表

> 不想每次改多处注册文件？看学习文档：  
> [`docs/dynamic-tool-discovery.md`](../../docs/dynamic-tool-discovery.md)（动态发现 / 自动派生白名单与 MCP，后续改造路线）
