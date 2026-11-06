# 动态发现工具（阶段 5 · 已落地）

> 讲清一件事：**工具清单只有一份**，其余全靠派生。  
> 本阶段已完成代码改造，本文既是学习笔记，也是改造后的现状说明。  
> 泳道图：[dynamic-tool-discovery-flow.svg](./dynamic-tool-discovery-flow.svg) · [flows-index.md](./flows-index.md)

相关源码：[`server/tools/README.md`](../server/tools/README.md) · [`server/tools/index.ts`](../server/tools/index.ts) · [`server/tools/discover.ts`](../server/tools/discover.ts) · [`server/tools/registry.ts`](../server/tools/registry.ts)

---

## 1. 改造前：工具是怎么注册的？

改造前，本项目把工具拆成两半，再在 `index.ts` **手工粘合**：

```
schemas/xxx.ts   → 给模型看的 Function Calling 描述（ToolSchema）
methods/xxx.ts   → 服务端真正执行的 run(rawArguments)
index.ts         → toolList: [{ name, schema, run }, ...]
```

调用链：

```
模型 tool_calls.name
    → findTool(name)          // Map 查找
    → tool.run(arguments)     // 或 multi-agent 的 runToolSafely
```

这本身很清晰，适合入门；问题出在**「清单」被抄成了多份**。

---

## 2. 痛点：加一个工具要改几处？

以新增 `getStockPrice` 为例，改造前至少要动 6 处：

| # | 文件 | 做什么 |
|---|------|--------|
| 1 | `server/tools/schemas/stock.ts` | 新建 schema |
| 2 | `server/tools/methods/stock.ts` | 新建 run |
| 3 | `server/tools/index.ts` | import + 写入 `toolList` |
| 4 | `server/guard/toolCallGuard.ts` | `ALLOWED_TOOLS` 加名字 |
| 5 | `server/mcp/createServer.ts` | 再 `registerTool` 一遍（MCP 侧重复登记） |
| 6 | （可选）Worker | 若要给 Realtime/KB 用，还要改硬编码名字列表 |

```ts
// 改造前 realtimeWorker.ts
const toolSchemas = ["getWeather", "getCurrentTime"]
  .map((name) => findTool(name)?.schema);
```

**核心问题**：schema / run / 白名单 / MCP / Worker 可见集，是 **多份清单**，容易漏改、改错名。
漏改的后果很具体：模型能选到工具，但 Guard 拒了；或者 MCP 侧根本没有这个工具。

「动态发现」要解决的，就是：**约定目录与导出形状，启动时自动扫出来，少改注册文件**。

---

## 3. 「动态发现」到底指什么？

在 Agent 项目里通常有两层含义，别混：

| 含义 | 谁在「检测」 | 本项目是否相关 |
|------|--------------|----------------|
| **A. 工具模块自动发现** | 服务端启动时扫目录 / 约定导出，生成注册表 | ✅ 本文重点（已落地） |
| **B. 模型动态决定调哪个工具** | LLM 根据 schema 选 tool_calls | ✅ 早有（ReAct），不是注册问题 |
| **C. 运行时从远程拉工具** | MCP / 插件市场 / HTTP tool server | 进阶，见文末 |

「每次都得改注册文件」→ 指的是 **A**。本阶段改造的也正是 A。

---

## 4. 现在的形态：唯一注册表

改造后，工具以**模块目录**为单元，每个目录导出一个 `ToolModule`：

```
server/tools/modules/
  getWeather/
    index.ts        → export const tool: ToolModule
  getCurrentTime/
    index.ts
  searchDocs/
    index.ts
  draft_message/
    index.ts
```

`schemas/` 与 `methods/` 仍然保留（复用现有实现，不重写业务逻辑），模块 `index.ts` 只做粘合：

```ts
export const tool: ToolModule = {
  name: "getWeather",
  schema: getWeatherTool,
  run: runGetWeather,
  tags: ["realtime"],
  risk: "read",
  includeInDefaultChat: true,
  mcp: { expose: true },
};
```

启动时（`tools/index.ts` 顶层 await）：

```
discoverTools()                     // 扫 modules/*，动态 import + 启动期校验
  → createRegistry(discovered)      // 去重 → Map → 派生所有对外清单
  → tools/index.ts 重新导出（对外 API 与改造前一致）
```

**关键点**：发现只扫 `server/tools/modules/` 这一个固定根目录，
目录名按 `localeCompare` 排序 → 日志、测试、注册顺序稳定。

---

## 5. 校验规则（发现失败就让启动挂掉）

`discoverTools()` 在启动期做这些检查：

1. 模块必须 `export const tool`
2. `name` 非空字符串
3. `schema.function.name` 存在且 `name === schema.function.name`
4. `run` 是函数
5. `tags` 是合法枚举（`realtime` / `kb` / `action`）且不重复
6. `risk` 是 `read` 或 `confirm`
7. 全局工具名唯一

任一条不满足 → **直接抛错、启动失败**，不允许静默跳过。
这是刻意的：注册漏了应该在启动时炸，而不是等模型在运行时调不到。

发现成功后打印一行启动日志（`NODE_ENV !== "test"`）：

```
[tools] discovered count=4 tools=[{"name":"draft_message","tags":["action"],"risk":"confirm","mcp":false}, …]
```

---

## 6. 派生：一个注册表，多处消费

`createRegistry()` 是全部派生逻辑的所在地：

```ts
createRegistry(tools) → {
  tools,                       // 全量模块
  toolSchemas,                 // 全部 schema
  findTool(name),              // Map 查找
  listTools(), listToolNames(),
  toolsWithTags(tags),         // Worker 可见集
  toolsWithMcp(),              // MCP 注册集
  isToolRequiringConfirm(name),// risk === "confirm"
  toolSchemasForChat(includeSearchDocs, includeConfirmTools?),
}
```

四路消费方全部改读注册表：

| 消费方 | 改造前 | 改造后 |
|--------|--------|--------|
| Guard 白名单 | 手抄 `ALLOWED_TOOLS` Set | `listToolNames().includes(name)` |
| MCP 注册 | 手工 3 次 `registerTool` | `for (const t of toolsWithMcp()) registerTool(...)` |
| Chat schema | 从 `toolList` 过滤 | `toolSchemasForChat(searchDocs, includeConfirmTools)` |
| Worker 可见集 | 手写名字数组 | `toolsWithTags(["realtime"] / ["kb"] / ["action"])` |

**注意**：`isToolRequiringConfirm` 之前是独立文件里一个写死的集合
（`react/toolsRequiringConfirm.ts` → `new Set(["draft_message"])`）。
现在它由 `risk === "confirm"` 判定，该文件已删除，循环依赖一并消除。

---

## 7. 什么不宜「全自动」？

### Worker 工具隔离必须显式策略

RealtimeWorker 只该看到天气/时间，KBWorker 只该看到 `searchDocs`。
若「扫到啥就全挂给模型」，会破坏多 Agent 边界。

本项目的做法：**清单自动，边界显式**。

```ts
// multi-agent/workers/realtimeWorker.ts
const toolSchemas = toolsWithTags(["realtime"]).map((t) => t.schema);
```

tag 是「归属声明」，不是「暴露开关」——工具自己声明属于哪类，
Worker 按类领取。**清单可以短、可以配置化，但不要变成「全量自动暴露」。**

### 不要动态执行任意路径上的代码

「扫目录 `import()`」只限定在 `server/tools/modules/`。
不要根据用户输入路径去加载工具——那是 RCE，不是插件系统。

### 「需人工确认」是风险级别，不是名字黑名单

改造前靠「名单里有 `draft_message`」判断；改造后靠模块声明 `risk: "confirm"`。
这样新增需确认工具时，不用再去改任何名单文件。

### MCP 入参要单独声明，不能直接复用 JSON Schema

`schema.function.parameters` 是**给模型看的 JSON Schema**；MCP 协议要求入参用 **zod shape** 描述。
两者格式不同，MCP 端没法直接吃 JSON Schema，所以 `mcp.inputSchema` 由模块自己声明：

```ts
// modules/getWeather/index.ts
mcp: {
  expose: true,
  inputSchema: { city: z.string().describe("城市名称，例如深圳、北京、广州") },
}
```

漏写会出两个坑：

- 没声明时 MCP 认为该工具「无参数」，回调第一个参数变成 `extra` 而不是 `args`；
- 于是 `run` 收到一坨协议内部对象，表现为 **「缺少参数 city」**——看起来像业务 bug，其实是注册期少了一步。

注册时对没有 `inputSchema` 的工具补空 shape（`{}`），保证回调签名一致。

---

## 8. 目录与类型约定（现状）

```
server/tools/
  index.ts          — 启动时 discoverTools() → createRegistry() → re-export
  types.ts          — ToolSchema / ToolDefinition / ToolModule / TOOL_TAGS / ToolRisk
  discover.ts       — 固定目录扫描 + 启动期校验
  registry.ts       — createRegistry()：派生所有清单
  modules/          — 每个子目录一个工具（export const tool: ToolModule）
    getWeather/index.ts
    getCurrentTime/index.ts
    searchDocs/index.ts
    draft_message/index.ts
  schemas/          — 给模型看的 Function Calling schema
  methods/          — 实际执行逻辑
  discovery.test.ts    — 发现与校验的正/负向测试
  toolRegistry.test.ts — 注册表派生行为测试
```

`ToolModule` 关键字段：

```ts
export interface ToolModule extends ToolDefinition {
  /** 与 schema.function.name 必须一致 */
  name: string;
  schema: ToolSchema;
  run: (rawArguments: string) => unknown | Promise<unknown>;
  /** 用于过滤：chat 默认、realtime、kb、action… */
  tags: readonly ToolTag[];
  /** read = 只读；confirm = 执行前必须人工确认 */
  risk: ToolRisk;
  /** 未勾选「搜索知识库」时是否仍暴露给单 Agent */
  includeInDefaultChat?: boolean;
  /** MCP 用；未声明 expose 则不挂到 MCP */
  mcp?: {
    expose: boolean;
    /** MCP 入参（zod raw shape）；缺省视为无参数 */
    inputSchema?: Record<string, ZodType>;
  };
}
```

---

## 9. 对照表：改造前 vs 改造后

| | 静态注册表（改造前） | 动态发现（现在） |
|--|-------------------|------------------|
| 加工具 | 改 3～6 个文件 | 加 1 个 module 目录 |
| 可读性 | 打开 index 一眼看全 | 看 modules 目录 |
| 漏改风险 | 高（白名单/MCP 易漏） | 低（清单派生） |
| Worker 隔离 | 手写名字数组 | tags 显式策略 |
| 确认名单 | 独立文件写死 | 模块声明 `risk` |
| 调试 | 简单 | 看启动发现日志 |
| 启动失败时机 | 运行到那一步才炸 | 启动期直接抛错 |

---

## 10. 测试覆盖了什么？

`server/tools/discovery.test.ts` 与 `server/tools/toolRegistry.test.ts` 覆盖：

- 合法模块集合 → 发现顺序按字母序（`draft_message` → `getCurrentTime` → `getWeather` → `searchDocs`）
- 缺 `run` 导出 → 拒绝
- 非法 `risk` / 非法 `tag` → 拒绝
- 工具重名 → 拒绝
- `isToolRequiringConfirm` 行为：`draft_message` 为 true，其余为 false
- `toolSchemasForChat` 四种组合：`(false)` / `(true)` / `(false,true)` / `(true,true)`

`server/guard/toolCallGuard.test.ts` 覆盖 Guard：注册表内放行、未注册拒绝、参数长度与 JSON 校验不变、
以及「源码里不再出现手抄名单」。

`server/mcp/createServer.test.ts` 覆盖 MCP 侧（走真实协议链路 `listTools` / `callTool`）：
派生工具集正确、`draft_message` 不暴露、`getWeather` 的 `city` 必填、**入参能真正传进 `run`**。

> 跑法：`npx tsx --test server/tools/*.test.ts server/guard/toolCallGuard.test.ts server/mcp/createServer.test.ts`

---

## 11. 和「模型动态选工具」的边界

动态**注册**解决的是工程师体验；动态**调用**早已由 ReAct 完成：

```
发给模型的 tools[]  ← 注册表 / 发现结果（可过滤）
模型返回 tool_calls ← 模型决策
applyToolCalls / runToolSafely ← 执行
```

不要指望「不注册也能调」——没进 schema 的工具，模型通常调不到；即使幻觉出名字，也会被 `toolCallGuard` 拦住。

---

## 12. 已知边界与后续

- `plan-execute/types.ts` 的 `PLAN_TOOL_NAMES` **仍是独立手写名单**：
  计划执行只允许 4 个工具，是有意的白名单（不是通用工具清单），本阶段未合并到注册表。
- `react/prefetchSearchDocs.ts`、`rag/answer.ts` 直接引用 `searchDocs`：
  它们是「知识库专用路径」，走 `validateToolCall("searchDocs")` + `retrieveForAnswer`，语义对齐工具层但不经 MCP/Chat schema。
- 阶段 5 交付页（调试页 / 日志页 / 成本页 / Evals 交付）尚未单独拆分。

---

## 13. 延伸阅读（本仓库）

| 话题 | 位置 |
|------|------|
| 工具模块约定与新增步骤 | `server/tools/README.md` |
| 工具执行与 Guard | `react/applyToolCalls.ts` · `guard/toolCallGuard.ts` |
| 多 Agent 安全执行 | `multi-agent/runToolSafely.ts` |
| MCP 挂载 | `mcp/createServer.ts` · `mcp/README.md` |
| 人工确认全链 | `docs/human-confirm-changelog.md` · `docs/multi-agent-human-confirm-changelog.md` |
| 方法级拓扑 | `docs/project-topology.html` §7b |
| messages / 工具角色 | `docs/project-messages-flow.md` |

---

## 14. 一句话总结

> **改造前**：工具能力写在文件里，**清单**抄在多处。  
> **现在**：用目录约定 + 启动扫描生成**唯一清单**，再派生白名单 / MCP / schema 列表；Worker 可见性用 **tags** 显式过滤，确认用 **risk** 显式声明，而不是全量裸奔。
