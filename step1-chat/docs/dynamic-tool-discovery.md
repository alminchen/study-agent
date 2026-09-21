# 动态检测 / 自动发现工具（学习文档）

> 面向后续改造：减少「每加一个工具就改一堆注册文件」。  
> 本文只讲思路与改造路线，**当前仓库仍是静态注册表**，未改运行时代码。  
> 泳道图：[dynamic-tool-discovery-flow.svg](./dynamic-tool-discovery-flow.svg) · [flows-index.md](./flows-index.md)

相关现状：[`server/tools/README.md`](../server/tools/README.md) · [`server/tools/index.ts`](../server/tools/index.ts)

---

## 1. 现在是怎么注册的？

本项目把工具拆成两半，再在 `index.ts` **手工粘合**：

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

这很清晰，适合入门；但 **「发现工具」完全靠人手改文件**。

---

## 2. 痛点：加一个工具要改几处？

以新增 `getStockPrice` 为例，当前至少要动：

| # | 文件 | 做什么 |
|---|------|--------|
| 1 | `server/tools/schemas/stock.ts` | 新建 schema |
| 2 | `server/tools/methods/stock.ts` | 新建 run |
| 3 | `server/tools/index.ts` | import + 写入 `toolList` |
| 4 | `server/guard/toolCallGuard.ts` | `ALLOWED_TOOLS` 加名字 |
| 5 | `server/mcp/createServer.ts` | 再 `registerTool` 一遍（MCP 侧重复登记） |
| 6 | （可选）Worker | 若要给 Realtime/KB 用，还要改硬编码名字列表 |

```87:88:server/multi-agent/workers/realtimeWorker.ts
  const toolSchemas = ["getWeather", "getCurrentTime"]
    .map((name) => findTool(name)?.schema)
```

**核心问题**：schema / run / 白名单 / MCP / Worker 可见集，是 **多份清单**，容易漏改、改错名。

「动态检测工具」要解决的，就是：**约定目录与导出形状，启动时自动扫出来，少改注册文件**。

---

## 3. 「动态检测」到底指什么？

在 Agent 项目里通常有两层含义，别混：

| 含义 | 谁在「检测」 | 本项目是否相关 |
|------|--------------|----------------|
| **A. 工具模块自动发现** | 服务端启动时扫目录 / 约定导出，生成注册表 | ✅ 本文重点 |
| **B. 模型动态决定调哪个工具** | LLM 根据 schema 选 tool_calls | ✅ 已有（ReAct），不是注册问题 |
| **C. 运行时从远程拉工具** | MCP / 插件市场 / HTTP tool server | 进阶，见文末 |

用户吐槽的「每次都得改注册文件」→ 指的是 **A**。

---

## 4. 目标形态（学完后你想要的）

理想：**业务同学只加一对文件，其它清单自动跟上**。

```
server/tools/modules/
  getWeather/
    schema.ts      // export const schema / name / tags
    run.ts         // export async function run(...)
    meta.ts        // 可选：tags、mcp zod、是否默认暴露给 chat
```

启动时：

```
discoverTools()
  → 扫描 modules/*
  → 校验 name / schema / run 齐全
  → 得到 ToolDefinition[]
  → 派生：
       toolByName Map
       ALLOWED_TOOLS（给 toolCallGuard）
       toolSchemasForChat(filter)
       MCP register 循环
```

新增工具：**只新建一个 module 目录**；不再手改 `index.ts` / `ALLOWED_TOOLS` / `createServer.ts` 三处名单（Worker 可见集仍建议显式，见 §7）。

---

## 5. 常见实现路线（按本仓库技术栈）

### 路线 1：约定导出 + 静态 import.meta.glob（推荐学习首选）

适合 **Vite / 部分打包器**；纯 `tsx` Node 服务也可手写 `fs.readdir` + 动态 `import()`。

思路：

```ts
// 伪代码：启动时扫 schemas + methods，按文件名配对
const schemaMods = await loadAll("./schemas/*.ts");
const methodMods = await loadAll("./methods/*.ts");

for (const key of keys(schemaMods)) {
  const schema = schemaMods[key].defaultOrNamedSchema;
  const run = methodMods[key].runXxx;
  register({ name: schema.function.name, schema, run });
}
```

**优点**：与现有 `schemas/` + `methods/` 目录兼容，改动小。  
**缺点**：要约定「文件名配对规则」或「两边导出同名 `name`」。

### 路线 2：自注册（side-effect register）

每个工具文件底部：

```ts
registerTool({ name: "getWeather", schema, run });
```

`index.ts` 只 `import "./modules/weather.js"` 等（或 glob import）。

**优点**：直觉接近插件。  
**缺点**：依赖 import 副作用，测试/tree-shaking 要注意；仍要有一份「import 列表」或 glob。

### 路线 3：单一模块目录（schema+run 同文件或同文件夹）

每个工具一个文件夹，导出统一接口：

```ts
export const tool: ToolModule = {
  name: "getWeather",
  schema: { ... },
  run: async (raw) => { ... },
  tags: ["realtime"],      // 给 Worker 过滤用
  mcpInput: { city: z.string() }, // 可选，给 MCP
};
```

**优点**：一份真相源，最适合「加工具零改注册表」。  
**缺点**：要一次性搬家现有三个工具。

### 路线 4：MCP 作为唯一工具源（远程动态）

本地不维护 schema，运行时 `list_tools` 从 MCP server 拉。

**优点**：真正「热插拔」。  
**缺点**：本学习项目已是「本地 tools → 再挂到 MCP」；反过来改成本高，留作进阶。

---

## 6. 和本项目其它模块怎么对齐？

动态发现后，下列地方应 **读注册表，而不是写死字符串**：

```
┌─────────────────┐
│ discoverTools() │  ← 唯一清单来源
└────────┬────────┘
         │
         ├─► findTool / toolSchemasForChat     （react / complete）
         ├─► toolCallGuard.ALLOWED_TOOLS       ← 从 name 集合派生
         ├─► runToolSafely                     （multi-agent）
         ├─► createStep1McpServer              ← for (tool of tools) register
         └─► Worker 可见集                     ← 用 tags 过滤，仍要声明策略
```

### 6.1 toolCallGuard

现在：

```ts
const ALLOWED_TOOLS = new Set(["getWeather", "getCurrentTime", "searchDocs"]);
```

改造后：

```ts
const ALLOWED_TOOLS = new Set(listToolNames()); // 与注册表同源
```

安全含义不变：**仍是白名单**；只是名单不再手抄第二份。

### 6.2 MCP

现在 `createServer.ts` 三个 `registerTool` 手工写。  
改造后对 `listTools()` 循环；若 MCP 需要 Zod `inputSchema`，放进 tool module 的 `mcpInput` 字段，避免再手写一份。

### 6.3 单 Agent chat

`toolSchemasForChat(includeSearchDocs)` 继续按 **tag / name 过滤**（例如 `searchDocs` 仅勾选知识库时暴露），过滤规则写在一处即可。

---

## 7. 什么不宜「全自动」？

### Worker 工具隔离必须显式策略

RealtimeWorker 只该看到天气/时间，KBWorker 只该看到 `searchDocs`。  
若「扫到啥就全挂给模型」，会破坏多 Agent 边界。

推荐保留：

```ts
// 策略显式，实现自动
const schemas = toolsWithTags(["realtime"]).map(t => t.schema);
// 或
const schemas = toolsNamed(["getWeather", "getCurrentTime"]).map(...);
```

**清单可以短、可以配置化，但不要变成「全量自动暴露」。**

### 不要动态执行任意路径上的代码

「扫目录 `import()`」只应限定在 `server/tools/modules/`（或现有 schemas/methods）。  
不要根据用户输入路径去加载工具——那是 RCE，不是插件系统。

---

## 8. 建议的目录约定（后续动手时）

可二选一，学习时建议先走 **兼容改造** 再 **搬家**：

### 阶段 A（小改）：配对现有目录

约定：

- `schemas/foo.ts` 必须导出 `schema`（或 `*Tool`）且 `schema.function.name` 稳定
- `methods/foo.ts` 必须导出 `run`（或 `run*`）
- 文件 stem 相同（`weather` ↔ `weather`）**或** 两边都带同一 `name` 字段用于配对

`index.ts` 变为：

```ts
export const toolList = await discoverFromSchemasAndMethods();
export function findTool(name: string) { ... }
export function listToolNames(): string[] { ... }
```

### 阶段 B（清晰）：modules 单模块

```
tools/
  discover.ts          — 扫描与校验
  registry.ts          — findTool / listTools / byTag
  modules/
    getWeather/
      index.ts         — export const tool: ToolModule
    getCurrentTime/
      index.ts
    searchDocs/
      index.ts
  index.ts             — re-export registry（对外 API 不变）
```

对外保持 `findTool` / `toolSchemasForChat`，上层（react / multi-agent）尽量不改。

---

## 9. ToolModule 类型草案（学习用）

```ts
export interface ToolModule {
  /** 与 schema.function.name 必须一致 */
  name: string;
  schema: ToolSchema;
  run: (rawArguments: string) => unknown | Promise<unknown>;
  /** 用于过滤：chat 默认、realtime、kb、mcp… */
  tags?: string[];
  /** 未勾选「搜索知识库」时是否仍暴露给单 Agent */
  includeInDefaultChat?: boolean;
  /** MCP 用；没有则 MCP 侧可跳过或用空 object */
  mcpInputSchema?: Record<string, unknown>;
}
```

校验（发现时跑一遍）：

1. `name === schema.function.name`
2. `typeof run === "function"`
3. `name` 全局唯一
4. `tags` 合法枚举

失败 → **启动直接抛错**（比运行时才发现「忘注册」更好）。

---

## 10. 对照：静态注册 vs 动态发现

| | 静态注册表（现状） | 动态发现（目标） |
|--|-------------------|------------------|
| 加工具 | 改 3～5 个文件 | 加 1 个 module |
| 可读性 | 打开 index 一眼看全 | 看 modules 目录 |
| 漏改风险 | 高（白名单/MCP 易漏） | 低（派生清单） |
| Worker 隔离 | 手写名字数组 | tags / 配置策略 |
| 调试 | 简单 | 需看 discover 日志 |
| 适合阶段 | 入门、演示 | 工具变多、多人协作 |

---

## 11. 后续动手学习清单（建议顺序）

不必一次做完，按周拆：

1. **盘点**：列出所有硬编码工具名（`index.ts`、`toolCallGuard`、`createServer`、两个 Worker）。
2. **抽 `listToolNames()`**：先仍手写 `toolList`，但 Guard 改为读 `listToolNames()`——消灭第一份重复。
3. **实现 `discover`**：`fs.readdir` + 动态 import，打印发现日志。
4. **MCP 循环注册**：删掉三个手工 `registerTool`。
5. **tags**：Realtime / KB Worker 改 `toolsWithTags(...)`。
6. **（可选）搬家到 `modules/`**，删除双目录配对。
7. **写一个新工具只加目录**，验证零改 `ALLOWED_TOOLS` / MCP。

验收标准：

- 新增工具不改 `toolCallGuard.ts`、不改 `mcp/createServer.ts`
- `findTool` / 单 Agent / 多 Agent / MCP 行为与现在一致
- 故意弄坏一个 module（缺 run）→ 进程启动失败并打出清晰错误

---

## 12. 和「模型动态选工具」的边界

动态**注册**解决的是工程师体验；动态**调用**已经由 ReAct 完成：

```
发给模型的 tools[]  ← 注册表 / 发现结果（可过滤）
模型返回 tool_calls ← 模型决策
applyToolCalls / runToolSafely ← 执行
```

不要指望「不注册也能调」——没进 schema 的工具，模型通常调不到；即使幻觉出名字，也会被 `toolCallGuard` 拦住。

---

## 13. 延伸阅读（本仓库）

| 话题 | 位置 |
|------|------|
| 当前注册与新增步骤 | `server/tools/README.md` |
| 工具执行与 Guard | `server/react/applyToolCalls.ts` · `server/guard/toolCallGuard.ts` |
| 多 Agent 安全执行 | `server/multi-agent/runToolSafely.ts` |
| MCP 挂载 | `server/mcp/createServer.ts` · `server/mcp/README.md` |
| messages / 工具角色 | `docs/project-messages-flow.md` |

---

## 14. 一句话总结

> **现在**：工具能力写在文件里，**清单**抄在多处。  
> **动态检测**：用目录约定 + 启动扫描生成**唯一清单**，再派生白名单 / MCP / schema 列表；Worker 可见性用 **tags/策略** 显式过滤，而不是全量裸奔。

准备动手改造时，从 §11 第 2 步（Guard 读 `listToolNames()`）开始成本最低、风险最小。
