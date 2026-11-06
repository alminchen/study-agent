# 阶段 5 · Tool 动态发现：执行计划

> 状态：**计划待确认，本轮只写文档，不改运行时代码。**
>
> 依据：`tasks/plan.md` 推荐顺序第 5 项、`tasks/todo.md` 第 8 节，
> 以及现有设计文档 `docs/dynamic-tool-discovery.md`。
>
> 定位：低风险工程改造。目标是把“工具注册清单”从多处手抄，改为一处发现、多处派生；
> 不改变模型选工具的方式，不改变现有工具行为，不改变前端协议。

---

## 1. 先说结论

这项改造最终只解决一件事：

> **新增一个工具时，只新增一个模块目录；Guard 白名单、Chat schema、MCP 注册、
> Worker 可见集都从同一份发现结果派生，不再手抄第二份名单。**

它不是“让模型自己发现工具”，也不是“运行时从远程拉工具”。
模型动态选择工具已经由现有 ReAct 完成；这次改造的是**服务端的工具注册与派生机制**。

---

## 2. 这是什么

### 2.1 现在的注册方式

当前工具由三部分拼起来：

```text
schemas/*.ts   给模型看的 Function Calling 描述
methods/*.ts   服务端真正执行的 run
index.ts       手工 import 两边，再登记进 toolList
```

调用链本身没有问题：

```text
模型返回 tool_calls.name
  -> findTool(name)
  -> tool.run(arguments)
```

问题在于“工具清单”被复制到了多个地方：

| 清单 | 位置 | 作用 |
| --- | --- | --- |
| 注册表 | `tools/index.ts` | name → schema + run |
| Guard 白名单 | `guard/toolCallGuard.ts` | 允许执行哪些工具 |
| 确认名单 | `react/toolsRequiringConfirm.ts` | 哪些工具必须先人工确认 |
| MCP 注册 | `mcp/createServer.ts` | MCP 对外暴露哪些工具 |
| Worker 可见集 | `workers/realtimeWorker.ts` 等 | 每个 Worker 能看到哪些工具 |

新增一个工具时，至少要改 3～5 个文件。漏改不会在启动时报错，
往往要等到模型真的调用时才暴露：Guard 拒绝、MCP 看不到、Worker 调不到。

### 2.2 “动态发现”的三种含义

这个词容易被混用，先分清：

| 含义 | 谁在发现 | 本项目 |
| --- | --- | --- |
| A. 工具模块自动发现 | 服务端启动时扫描固定目录 | **本次要做** |
| B. 模型动态选择工具 | LLM 根据 schema 返回 tool_calls | 已有，不需要改 |
| C. 运行时从远程拉工具 | MCP 远程 server、插件市场 | 不做，留作进阶 |

本次只做 A。B 是模型行为，C 是协议与信任边界问题，不能混在一起。

### 2.3 目标形态

```text
tools/
  discover.ts       扫描固定目录，校验模块
  registry.ts       生成 Map、按 tag 过滤、派生 Chat schema
  types.ts          ToolModule / ToolDefinition 类型
  modules/
    getWeather/
      index.ts      export const tool
    getCurrentTime/
      index.ts
    searchDocs/
      index.ts
    draft_message/
      index.ts
  index.ts          对外薄门面，保持 findTool 等旧 API
```

启动时：

```text
discoverTools()
  -> 扫描 tools/modules/*
  -> 校验 name / schema / run / tags / risk
  -> 得到 ToolModule[]
  -> registry 派生：
       toolByName Map
       listToolNames()         给 Guard
       toolSchemasForChat()    给单 Agent
       toolsWithTags()         给 Worker
       toolsWithMcp()          给 MCP
```

新增工具只加一个目录。其他清单自动跟上。

---

## 3. 为什么要学这个路径

### 3.1 这是工程问题，不是模型问题

模型会不会调工具，取决于 schema 描述、system prompt 和任务本身。
本次改造不碰这些，只碰“工具怎么被登记、怎么被派生”。

所以它能带来的提升不是“回答更聪明”，而是：

- 加工具更快
- 清单不容易漏
- 配错时启动就失败
- 多 Agent 的工具边界更清楚
- 后面加权限、风险级别、MCP 暴露时有统一入口

### 3.2 为什么现在适合做

现有设计文档已经把现状、目标、路线、边界和验收写清楚，
代码里也只有 4 个工具，迁移成本可控。

更重要的是，这项改造可以拆成多个**行为等价**的小步骤：

1. 先让 Guard 读注册表，不改变任何工具行为。
2. 再把工具元数据收进模块，仍然保持旧 API。
3. 最后才启用目录扫描和派生。

每一步都能单独测试、单独回滚。相比一次性大搬家，这是低风险路径。

### 3.3 为什么不做成“全自动”

三个边界必须保留：

- **不全量暴露给所有 Agent**：Worker 的工具隔离是安全边界，不是注册便利。
  自动发现只解决清单同步，不解决“谁应该看到什么”。
- **不动态加载任意路径**：只扫描固定目录，绝不根据用户输入拼路径。
  否则不是插件系统，而是远程代码执行漏洞。
- **不做运行时热插拔**：本阶段只要求重启后生效。
  热更新涉及缓存、版本、权限和正在执行的任务，复杂度不值得。

### 3.4 为什么不继续手写

手写注册表在 3 个工具时很清楚，但工具一多就会出现：

- `index.ts` 和 Guard 名单不一致
- MCP 少注册一个工具
- Worker 看到了不该看的工具
- 重名工具悄悄覆盖
- 缺 `run` 的模块直到调用时才报错

这些都是“清单重复”带来的，不是业务逻辑问题。
用一个唯一来源派生，能从结构上消掉这类错误。

---

## 4. 学完能做什么

### 4.1 直接产出

- 新增工具只建一个目录，不再改 `tools/index.ts`、Guard 白名单和 MCP 注册。
- Guard 白名单与注册表同源，模型幻觉出的工具名仍然会被拒绝。
- MCP 自动注册所有标记为暴露的工具，不再逐个手写。
- Realtime / KB / Action Worker 通过 tag 取工具，策略仍然显式。
- 模块缺字段、重名、schema 名字不一致时，启动直接失败并给出模块名。
- 启动日志能列出发现数量、名称、tags、风险级别和 MCP 暴露状态。

### 4.2 学习价值

这项改造练的是四个通用能力：

1. **单一事实源**：同一份数据只维护一次。
2. **派生清单**：白名单、MCP、Chat schema 都是派生结果，不是第二份真相。
3. **启动期校验**：配置错误尽早失败，不把问题拖到运行时。
4. **策略与机制分离**：发现是机制，Worker 可见性是策略。

这四点以后做权限系统、插件体系、MCP 工具市场都用得上。

### 4.3 对作品集的价值

它不是一个“看起来更智能”的功能，但能说明你理解：

- 工具注册表怎么设计
- 白名单为什么要从注册表派生
- 多 Agent 的工具隔离怎么做
- 动态 import 的安全边界在哪里
- 怎么用测试证明“行为没变”

这类工程细节比再加一个玩具工具更能体现工程质量。

---

## 5. 目标与非目标

### 5.1 本次目标

- 建立 `ToolModule` 元数据契约。
- 把现有 4 个工具迁入固定模块目录。
- 实现固定目录扫描、动态 import、启动校验。
- 让 Guard、Chat schema、MCP、Worker 都从注册表派生。
- 用自动测试证明行为等价，并覆盖失败路径。

### 5.2 本次不做

- 不改变模型选工具的逻辑。
- 不改变 ReAct / Plan-and-Execute / Multi-Agent 的图结构。
- 不改变 `/api/chat`、`/api/chat/multi` 的 SSE 事件和前端协议。
- 不做远程 MCP 工具源，不做插件市场。
- 不做运行时热更新。
- 不引入通用权限系统；只保留 `risk: "read" | "confirm"`。
- 不为了演示新增生产用玩具工具。
- 不一次性重写所有 schema 和 method 文件。

### 5.3 行为等价基线

| 行为 | 改造前 | 改造后必须一致 |
| --- | --- | --- |
| Guard 允许 | 4 个工具名 | 4 个工具名 |
| 默认 Chat schema | `getWeather`、`getCurrentTime` | 同左 |
| 勾选知识库 | 追加 `searchDocs` | 同左 |
| 启用确认工具 | 追加 `draft_message` | 同左 |
| MCP 对外工具 | `getWeather`、`getCurrentTime`、`searchDocs` | 同左，不含 `draft_message` |
| Realtime Worker | 天气、时间 | 同左 |
| KB Worker | `searchDocs` | 同左 |
| Action Worker | `draft_message` | 同左 |

---

## 6. 设计决策

### 6.1 采用“固定目录扫描 + 启动校验”

**选择**：`discoverTools()` 只扫描 `tools/modules/`，启动时完成发现和校验。

**理由**：

- 目录固定，不存在用户可控路径。
- 启动时失败比运行时失败更容易定位。
- 发现结果可以缓存，不需要每次请求都扫描。

**放弃的方案**：

- 请求时懒加载：增加首字延迟，错误出现在用户请求里。
- 任意路径 import：安全边界不可控。
- Vite `import.meta.glob`：主要面向客户端构建，服务端由 `tsx` 运行，
  不适合作为唯一机制。

### 6.2 采用“单模块目录”，但分两步迁移

**选择**：每个工具一个目录，导出统一的 `tool` 对象。

**迁移策略**：

- 第一步：模块 `index.ts` 组合现有 schema 和 method，先统一注册入口。
- 第二步：确认行为不变后，再决定是否把 schema / run 搬进模块目录。

**理由**：

- 先改注册结构，不同时搬业务实现，diff 更小。
- 每个工具迁移后都能单独回归。
- 现有 `methods/` 里的检索、确认逻辑不需要重写。

**注意**：迁移完成后，“注册源”必须是模块目录。
旧 `schemas/` / `methods/` 可以暂时保留为实现文件，但不能继续维护第二份注册清单。

### 6.3 采用“启动失败”，不静默跳过坏模块

**选择**：模块缺 `run`、重名、`name` 与 schema 不一致、tag 非法、import 抛错，
都让进程启动失败。

**理由**：

- 跳过坏模块会让工具“神秘消失”，比启动失败更难排查。
- 启动失败能强制修正配置，不会带病上线。

**错误信息要求**：

- 只打印模块目录名，例如 `getWeather`。
- 不打印绝对路径，满足路径隐私规则。
- 错误必须包含原因，例如 `missing run`、`duplicate name getWeather`、
  `name !== schema.function.name`。

### 6.4 采用“显式 tag + 显式 Chat 开关”，不做全量暴露

**选择**：

- `tags` 只用于 Worker 可见性：`realtime`、`kb`、`action`。
- `includeInDefaultChat` 控制 Chat 默认是否暴露。
- `risk` 控制是否需要人工确认。
- `mcp.expose` 控制是否注册到 MCP。

**理由**：

- 四个维度语义不同，不能都塞进 tags。
- Worker 的工具隔离必须显式，不能“扫到啥就挂啥”。
- MCP 暴露是独立策略，不适合用 tag 间接表达。

### 6.5 不引入运行时开关

**选择**：不保留 `TOOLS_SOURCE=static|discover` 双通道。

**理由**：

- 双通道意味着两份注册源，会重新引入 drift。
- 本次改造分阶段提交，每一步都可单独回滚。
- 行为等价由测试保证，不靠运行时切换。

### 6.6 公开 API 保持不变

`tools/index.ts` 继续导出：

- `findTool(name)`
- `toolSchemasForChat(includeSearchDocs, includeConfirmTools)`
- `toolSchemas`

新增：

- `listTools()`
- `listToolNames()`
- `toolsWithTags(tags)`
- `toolsWithMcp()`

上层 `react`、`multi-agent`、`plan-execute`、`tracing` 尽量不改。

---

## 7. ToolModule 契约

建议先扩展 `tools/types.ts`，保持 `ToolDefinition` 兼容：

```ts
import type { ZodTypeAny } from "zod";

export const TOOL_TAGS = ["realtime", "kb", "action"] as const;
export type ToolTag = (typeof TOOL_TAGS)[number];
export type ToolRisk = "read" | "confirm";

export interface ToolModule {
  /** 必须与 schema.function.name 完全一致 */
  name: string;
  schema: ToolSchema;
  run: (rawArguments: string) => unknown | Promise<unknown>;
  /** Worker 可见性；可以为空数组 */
  tags: readonly ToolTag[];
  /** read：直接执行；confirm：先走人工确认 */
  risk: ToolRisk;
  /** 默认 true；searchDocs 设为 false，表示需要显式勾选 */
  includeInDefaultChat?: boolean;
  /** MCP 暴露策略；不写表示不暴露 */
  mcp?: {
    expose: boolean;
    /** 只给 MCP 用的 Zod 入参；与 Chat schema 同源维护 */
    inputSchema?: Record<string, ZodTypeAny>;
  };
}
```

### 7.1 现有工具的元数据映射

| 工具 | tags | risk | includeInDefaultChat | MCP |
| --- | --- | --- | --- | --- |
| `getWeather` | `["realtime"]` | `read` | `true` | 暴露，`city` |
| `getCurrentTime` | `["realtime"]` | `read` | `true` | 暴露，无入参 |
| `searchDocs` | `["kb"]` | `read` | `false` | 暴露，`question` |
| `draft_message` | `["action"]` | `confirm` | `true` | 不暴露 |

**关键细节**：`draft_message` 的 `includeInDefaultChat` 必须是 `true`。
当前 `toolSchemasForChat(false, true)` 会包含它；如果设成 `false`，
启用确认工具时行为会变化。它默认不出现，是因为 `risk: "confirm"` 被第二个过滤条件挡掉。

### 7.2 Chat schema 派生规则

保持现有签名和语义：

```ts
toolSchemasForChat(includeSearchDocs, includeConfirmTools)
```

过滤规则改为：

```text
第一层：includeInDefaultChat !== false
        或 (includeSearchDocs && tags 包含 "kb")
第二层：includeConfirmTools || risk !== "confirm"
```

四种组合必须与改造前一致：

| includeSearchDocs | includeConfirmTools | 结果 |
| --- | --- | --- |
| false | false | `getWeather`、`getCurrentTime` |
| true | false | 再加 `searchDocs` |
| false | true | 再加 `draft_message` |
| true | true | 全部 4 个 |

### 7.3 Worker 派生规则

```text
Realtime Worker -> toolsWithTags(["realtime"])
KB Worker       -> toolsWithTags(["kb"])
Action Worker   -> toolsWithTags(["action"])
```

如果某个 Worker 过滤后为空，应直接报错或启动失败。
不要让它带着空工具集去问模型，否则只会得到“工具不可用”的模糊回答。

### 7.4 MCP 派生规则

```text
toolsWithMcp() -> 遍历 mcp.expose === true 的模块
  -> registerTool(name, { description, inputSchema? }, handler)
```

没有 `inputSchema` 的工具不传该字段，保持现有 `getCurrentTime` 的注册形态。
`draft_message` 不暴露，保持 MCP 只有 3 个工具。

---

## 8. 分阶段执行

### 8.0 执行步骤总表

下面是真正动手时按顺序勾选的清单。每一步只做一件事，做完立刻验证，再进入下一步。

| # | 动作 | 主要文件 | 完成判据 |
| --- | --- | --- | --- |
| 0.1 | 盘点全部硬编码工具名和消费方 | `tools/index.ts`、`guard/toolCallGuard.ts`、`mcp/createServer.ts`、`workers/*.ts` | 4 个工具名都有完整消费方表 |
| 0.2 | 记录改造前行为基线 | 本文档 | 记录 Chat 四种组合、MCP、三个 Worker 的可见集 |
| 1.1 | 增加 `listTools()` / `listToolNames()` | `tools/index.ts` | 两个函数可被 Guard 调用 |
| 1.2 | Guard 白名单改为从注册表派生 | `guard/toolCallGuard.ts` | 文件内不再出现具体工具名 |
| 1.3 | 跑步骤组 1 回归 | 无 | `npm run typecheck` 通过 |
| 2.1 | 定义 `ToolModule` / `ToolTag` / `ToolRisk` | `tools/types.ts` | 类型可被模块引用 |
| 2.2 | 迁移 `getWeather` 模块 | `getWeather/index.ts` | schema/run 与改造前一致 |
| 2.3 | 迁移 `getCurrentTime` 模块 | `getCurrentTime/index.ts` | 同上 |
| 2.4 | 迁移 `searchDocs` 模块 | `searchDocs/index.ts` | `includeInDefaultChat: false` 生效 |
| 2.5 | 迁移 `draft_message` 模块 | `draft_message/index.ts` | `risk: "confirm"` 生效 |
| 2.6 | `tools/index.ts` 改为静态 import 模块 | `tools/index.ts` | 仍不扫描目录，行为不变 |
| 2.7 | 跑模块迁移回归 | 无 | Chat 四种组合与基线一致 |
| 3.1 | 实现固定目录扫描和校验 | `tools/discover.ts` | 缺字段、重名、名字不一致会报错 |
| 3.2 | 实现注册表派生 API | `tools/registry.ts` | `findTool`、`toolsWithTags`、`toolsWithMcp` 可用 |
| 3.3 | `tools/index.ts` 改为启动时发现 | `tools/index.ts` | 重启后 4 个工具全部被发现 |
| 3.4 | 增加启动发现日志 | `tools/discover.ts` | 日志不含绝对路径 |
| 3.5 | 写发现正向/负向测试 | `tools/discover.test.ts` | 正常模块通过，坏模块启动失败 |
| 4.1 | MCP 改为循环注册 | `mcp/createServer.ts` | 仍只暴露 3 个工具 |
| 4.2 | Realtime Worker 改为 tag 过滤 | `workers/realtimeWorker.ts` | 只看到天气、时间 |
| 4.3 | KB Worker 改为 tag 过滤 | `workers/kbWorker.ts` | 只看到 `searchDocs` |
| 4.4 | Action Worker 改为 tag 过滤 | `workers/actionWorker.ts` | 只看到 `draft_message` |
| 4.5 | 确认名单改为读 `risk` | `react/toolsRequiringConfirm.ts` | 文件内不再出现 `draft_message` |
| 4.6 | Chat schema 派生下沉到 registry | `tools/registry.ts` | `react/complete.ts` 调用方式不变 |
| 5.1 | 加“只加目录也能被发现”测试 | `tools/discover.test.ts` | 不改注册表也能发现假工具 |
| 5.2 | 加四类坏模块测试 | `tools/discover.test.ts` | 缺 run、重名、名字不一致、非法 tag 全部失败 |
| 5.3 | 加行为回归测试 | `tools/discover.test.ts` | Chat、Guard、Worker、MCP 结果与基线一致 |
| 6.1 | 跑静态检查和构建 | 无 | `npm run typecheck`、`npm run build` 通过 |
| 6.2 | 跑 MCP 集成验收 | 无 | `npm run mcp:ping` 通过 |
| 6.3 | 跑单/多 Agent Evals | 无 | 有 Key 则通过；无 Key 如实记录未运行 |
| 6.4 | 更新 README、设计文档和 todo | `tools/README.md`、`docs/dynamic-tool-discovery.md`、`tasks/todo.md` | 文档步骤与实际代码一致 |
| 6.5 | 最终 diff 审计 | 无 | 没有遗留手写工具名和绝对路径 |

### 8.0.1 每一步的固定工作流

每个编号步骤都按同一节奏做：

1. **读**：先打开该步骤涉及的文件，确认当前行为。
2. **改**：只改这一小步需要的文件，不顺手动别的逻辑。
3. **验**：跑该步骤的局部测试或 `npm run typecheck`。
4. **记**：在 `tasks/todo.md` 对应项写实际结果，不写空泛的“已完成”。
5. **停**：确认 diff 只包含本步内容，再进入下一步。

### 8.0.2 依赖关系

```text
步骤组 0 盘点
  -> 步骤组 1 Guard 派生（可独立回滚）
  -> 步骤组 2 模块迁移
  -> 步骤组 3 目录发现
  -> 步骤组 4 MCP / Worker / 确认名单
  -> 步骤组 5 测试补齐
  -> 步骤组 6 回归与文档
```

步骤组 4 必须等步骤组 3 的注册表稳定后再做；步骤组 2 和步骤组 3 不要合并成一个提交。

---

### 步骤组 0：盘点硬编码工具名（只读）

**目标**：把所有硬编码位置列全，避免迁移时漏掉消费方。

**检查位置**：

- `tools/index.ts`
- `guard/toolCallGuard.ts`
- `react/toolsRequiringConfirm.ts`
- `mcp/createServer.ts`
- `workers/realtimeWorker.ts`
- `workers/kbWorker.ts`
- `workers/actionWorker.ts`
- `react/complete.ts`
- `plan-execute/executor.ts`
- `tracing/langsmith.ts`

**产出**：

一张表，列出“文件 → 硬编码的名字 → 用途 → 迁移后从哪个 API 派生”。

**盘点结果（2026-11-06）**：

| 消费方 | 硬编码内容 | 当前用途 | 迁移后派生方式 |
| --- | --- | --- | --- |
| `tools/index.ts` | `getWeather`、`getCurrentTime`、`searchDocs`、`draft_message` | 建立 name 到 schema + run 的运行时注册表 | 注册表自身就是唯一事实源 |
| `guard/toolCallGuard.ts` | 4 个工具名 | 执行前判断工具是否允许调用 | `listToolNames()` |
| `react/toolsRequiringConfirm.ts` | `draft_message` | 判断需要人工确认的工具 | `toolsWithRisk("confirm")` |
| `mcp/createServer.ts` | 3 个 MCP 工具 | 逐个 `registerTool`，对外暴露 MCP 能力 | `toolsWithMcp()` |
| `workers/realtimeWorker.ts` | `getWeather`、`getCurrentTime` | Realtime Worker 可见工具集 | `toolsWithTags(["realtime"])` |
| `workers/kbWorker.ts` | `searchDocs` | KB Worker 可见工具集 | `toolsWithTags(["kb"])` |
| `workers/actionWorker.ts` | `draft_message` | Action Worker 可见工具集 | `toolsWithTags(["action"])` |

除了直接注册与执行边界，还有一批**派生与展示位置**迁移后要评估是否改为同源：

| 消费方 | 引用内容 | 当前用途 | 迁移后处理 |
| --- | --- | --- | --- |
| `plan-execute/types.ts` | `PLAN_TOOL_NAMES` | Plan-and-Execute 的计划工具名集合 | 先保留为策略常量；若确认它只是注册表子集，再改为派生 |
| `plan-execute/prompts.ts` | 工具目录文案 | 给 Planner 展示可用工具 | 优先保留文案；可由注册表注入名称，不强行同源 |
| `chat.ts` | system prompt 工具说明 | 引导模型选择工具 | 本轮不改 prompt 逻辑；后续按派生目录评估 |
| `src/types.ts` | `PlanToolName` | 前端计划类型 | 本轮不改前端协议；保留现有类型 |
| `tracing/langsmith.ts` | 工具名 | trace 或指标命名 | 只做观察用途，迁移后确认是否统一来源 |

不迁移的数据级引用：

| 位置 | 说明 |
| --- | --- |
| `evals/dataset*.json` | 测试剧本和数据期望是验收基线，不因注册机制变化而修改 |
| `scripts/mcp-ping.ts` | 独立集成探测脚本，保留固定工具名更利于发现回归 |
| `scripts/run-plan-evals.ts` | 评测执行脚本，工具名属于剧本与断言语义 |
| README 和设计文档 | 记录当前行为，等代码迁移完成后统一更新 |

**行为基线（改造前）**：

| 场景 | 可见或允许的工具 |
| --- | --- |
| Guard | `getWeather`、`getCurrentTime`、`searchDocs`、`draft_message` |
| Chat 默认 | `getWeather`、`getCurrentTime` |
| Chat 勾选知识库 | 默认两个 + `searchDocs` |
| Chat 启用确认工具 | 默认两个 + `draft_message` |
| Chat 知识库 + 确认工具 | 4 个工具全部可见 |
| MCP | `getWeather`、`getCurrentTime`、`searchDocs`，不含 `draft_message` |
| Realtime Worker | `getWeather`、`getCurrentTime` |
| KB Worker | `searchDocs` |
| Action Worker | `draft_message` |

**盘点结论**：

- 代码运行链路里有 7 个直接硬编码消费方，是本次迁移要改的位置。
- 派生与展示位置涉及 prompt、协议和 trace，不能盲目同源；后续按“行为等价”原则逐个判断。
- 数据、剧本和文档引用不参与运行时注册，保持不动。

**验收**：

- 4 个工具名都能在表中找到所有消费方。
- 特别确认 `actionWorker.ts` 也有硬编码 `draft_message`；
  现有计划只列了两个 Worker，实际是三个。

**风险**：只读阶段，无代码风险。

---

### 步骤组 1：先加 `listToolNames()`，让 Guard 读注册表

**目标**：消灭第一份重复清单，风险最小。

**改动**：

- 在 `tools/index.ts` 新增：
  - `listTools()`
  - `listToolNames()`
- `guard/toolCallGuard.ts` 删除手写 `ALLOWED_TOOLS`，
  改为 `new Set(listToolNames())` 或每次 `listToolNames().includes(name)`。

**不改**：

- 不改工具定义。
- 不改 MCP。
- 不改 Worker。
- 不改 Chat schema。

**测试**：

- 4 个已注册工具都允许。
- 未注册工具被拒绝。
- 参数超长、非法 JSON 的拒绝行为不变。

**验收**：

- `guard/toolCallGuard.ts` 中不再出现任何具体工具名。
- `npm run typecheck` 通过。
- 现有聊天和测试行为不变。

**回滚**：恢复一行白名单即可。

**建议**：这是第一个可独立提交的改动。先做完并验证，再进入下一阶段。

**执行结果（2026-11-06）**：

| 项 | 结果 |
| --- | --- |
| `listTools()` / `listToolNames()` | 已新增到注册表门面，返回现有 4 个工具 |
| Guard 白名单 | 已改为读取 `listToolNames()`，文件内不再手写具体工具名 |
| 专项测试 | 新增 4 条 Guard 测试，覆盖 4 个注册工具、未注册工具、超长参数、非法 JSON 和名单同源 |
| 测试命令 | `node --import tsx --test server/guard/toolCallGuard.test.ts`，4/4 通过 |
| 类型检查 | `npm run typecheck` 通过 |
| 行为影响 | 工具定义、MCP、Worker、Chat schema 未改；Guard 允许集合仍为 4 个工具 |
| 命令差异 | 沙箱内 `npx tsx --test` 因 IPC 管道受限失败；改用 Node loader 运行同一测试 |

---

### 步骤组 2：定义 `ToolModule`，逐个迁入模块目录

**目标**：让模块目录成为唯一注册源，同时保持旧 API。

**改动**：

1. 在 `tools/types.ts` 增加 `ToolModule`、`ToolTag`、`ToolRisk`。
2. 新建 `tools/modules/`。
3. 每个工具新增一个 `index.ts`：

```ts
import { getWeatherTool } from "../../schemas/weather.js";
import { runGetWeather } from "../../methods/weather.js";
import type { ToolModule } from "../../types.js";

export const tool: ToolModule = {
  name: "getWeather",
  schema: getWeatherTool,
  run: runGetWeather,
  tags: ["realtime"],
  risk: "read",
  includeInDefaultChat: true,
  mcp: {
    expose: true,
    // inputSchema 在 MCP 阶段接入
  },
};
```

4. `tools/index.ts` 先改为静态 import 这 4 个模块，组装 `toolList`。
   此时仍不扫描目录，先验证元数据和行为。

**迁移顺序**：

1. `getWeather`
2. `getCurrentTime`
3. `searchDocs`
4. `draft_message`

每迁一个，跑一次 typecheck 和相关回归。不要一次改完 4 个再看结果。

**执行结果（2026-11-06）**：

| 项 | 结果 |
| --- | --- |
| 元数据契约 | `tools/types.ts` 新增 `TOOL_TAGS`、`ToolTag`、`ToolRisk`、`ToolModuleMcp`、`ToolModule`；`ToolDefinition` 保持兼容 |
| 工具模块 | 4 个工具已迁入 `tools/modules/<tool>/index.ts`，静态组合 schema 与 run |
| 元数据映射 | 天气/时间：`realtime`、`read`、默认 Chat、MCP 暴露；检索：`kb`、`read`、显式勾选、MCP 暴露；草稿：`action`、`confirm`、可显式暴露、不进 MCP |
| 注册表 | `tools/index.ts` 改为静态 import 4 个模块，仍不扫描目录；`findTool`、`toolSchemasForChat` 签名不变 |
| 行为测试 | 新增注册表测试，验证顺序、schema 身份、Chat 四种组合和元数据映射 |
| 测试命令 | `node --import tsx --test server/tools/toolRegistry.test.ts server/guard/toolCallGuard.test.ts`，7/7 通过 |
| 类型检查 | `npm run typecheck` 通过 |
| 外部影响 | MCP、Worker、确认名单、前端协议未改 |

**验收**：

- `findTool(name)?.schema` 与迁移前是同一个 schema。
- `findTool(name)?.run` 行为不变。
- `toolSchemasForChat` 四种组合结果与基线一致。
- MCP 仍是 3 个工具（此时还没改 MCP，先确认元数据没影响它）。

**回滚**：单个工具回滚对应模块和 `index.ts` 的一行 import。

**注意**：

- 模块目录里的 `index.ts` 不要 import `tools/index.ts`，否则会和注册表形成循环依赖。
- 迁移期间不要同时改 schema 文案和 run 逻辑，否则回归失败时无法判断原因。

> 2026-11-06：上述迁移已一次性完成，但用统一行为测试验证了迁移前后顺序、
> schema 身份、四种 Chat 组合和元数据；未改 schema 文案与 run 逻辑。

---

### 步骤组 3：实现 `discoverTools()` 和 `registry.ts`

**目标**：用固定目录扫描替代静态 import 列表。

**新增 `tools/discover.ts`**：

- 默认扫描 `tools/modules/`。
- 只接受目录下的 `index.ts` 或 `index.js`。
- 按目录名排序，保证日志和测试稳定。
- 动态 import 使用 `pathToFileURL`，不使用用户输入拼路径。
- 对 `unknown` 模块做运行时校验，不直接 `as ToolModule`。

**新增 `tools/registry.ts`**：

- `createRegistry(tools)`：构建 `Map`，检查重名。
- `findTool(name)`
- `listTools()`
- `listToolNames()`
- `toolsWithTags(tags)`
- `toolsWithMcp()`
- `toolSchemasForChat(...)`

**修改 `tools/index.ts`**：

```ts
const discovered = await discoverTools();
const registry = createRegistry(discovered);

export const toolList = registry.tools;
export const toolSchemas = registry.toolSchemas;
export const findTool = registry.findTool;
export const listTools = registry.listTools;
export const listToolNames = registry.listToolNames;
export const toolsWithTags = registry.toolsWithTags;
export const toolsWithMcp = registry.toolsWithMcp;
export const toolSchemasForChat = registry.toolSchemasForChat;
```

**关于顶层 await**：

- 项目是 ESM，`tsx` 支持顶层 await。
- 所有消费方都是静态 import，会等待模块求值完成。
- 前提是模块之间没有循环依赖。
- 如果发现循环依赖，退回“显式 `await initTools()` + 启动时调用”，
  不要用未完成的注册表继续跑。

**启动日志**：

```text
[tools] discovered count=4 tools=[...]
```

日志只包含：

- 名称
- tags
- risk
- 是否暴露到 MCP

不打印绝对路径。

**校验规则**：

1. 模块必须导出 `tool`。
2. `tool.name` 非空。
3. `tool.name === tool.schema.function.name`。
4. `tool.run` 是函数。
5. `tool.tags` 是数组，元素在 `TOOL_TAGS` 内，无重复。
6. `tool.risk` 是 `read` 或 `confirm`。
7. 所有工具名全局唯一。
8. `mcp.expose === true` 时，`mcp.inputSchema` 必须是对象（如果提供）。

**验收**：

- 新增/删除模块后，重启服务即可生效。
- 发现顺序稳定。
- 4 个工具全部被发现，名称和元数据正确。
- `findTool`、`toolSchemasForChat` 行为不变。

**回滚**：保留步骤组 2 的静态 import 版本作为回滚点，或直接 revert 本步骤组。

---

### 步骤组 4：让 MCP、Worker、确认名单都读注册表

**目标**：删除剩余的手工清单。

**MCP**：

- `mcp/createServer.ts` 删除 3 个手工 `registerTool`。
- 改为遍历 `toolsWithMcp()`。
- `description` 继续复用 `schema.function.description`。
- `inputSchema` 来自模块的 `mcp.inputSchema`。
- 执行继续复用 `run`，不重写业务校验。

**Worker**：

- `realtimeWorker.ts` 改为 `toolsWithTags(["realtime"])`。
- `kbWorker.ts` 改为 `toolsWithTags(["kb"])`。
- `actionWorker.ts` 改为 `toolsWithTags(["action"])`。
- 保留各自的 system prompt 和职责边界。

**确认名单**：

- `react/toolsRequiringConfirm.ts` 改为读注册表的 `risk === "confirm"`。
- 它应从 `tools/registry.ts` 读取，不要从 `tools/index.ts` 读取，避免循环依赖。
- `tools/index.ts` 内部过滤确认工具时直接用 `tool.risk`，不要反向 import
  `toolsRequiringConfirm.ts`。

**Chat schema**：

- `toolSchemasForChat` 移到 registry，按第 7.2 节规则派生。
- `react/complete.ts` 不改调用方式。

**验收**：

- `mcp/createServer.ts` 中不再出现具体工具名。
- 三个 Worker 中不再出现工具名数组。
- `toolsRequiringConfirm.ts` 中不再出现 `draft_message`。
- MCP 仍只列出 3 个工具。
- Worker 可见集与改造前一致。

**回滚**：MCP 和 Worker 可以分别回滚，不要捆在一个提交里。

---

### 步骤组 5：补齐结构测试和失败测试

**目标**：用测试证明“新增工具只加目录”和“坏模块启动失败”。

**测试文件**：`tools/discover.test.ts`，使用 `node:test` + `node:assert/strict`，
与现有 `plan-execute/*.test.ts` 风格一致。

**正向测试**：

1. 发现现有 4 个工具，名称、tags、risk、MCP 暴露状态正确。
2. 在临时目录放一个假工具模块，只调用 `discoverTools({ rootDir })`，
   不修改 `tools/index.ts`、Guard、MCP 和 Agent 图，也能被发现。
3. 假工具带 `kb` tag 时，`toolSchemasForChat(true, false)` 能包含它。
4. 假工具带 `mcp.expose` 时，`toolsWithMcp()` 能包含它。

**负向测试**：

1. 模块缺 `run` → 发现失败，错误包含模块名和 `run`。
2. 两个模块同名 → 发现失败，错误包含重复名称。
3. `name` 与 `schema.function.name` 不一致 → 发现失败。
4. tag 不在允许枚举内 → 发现失败。
5. 模块 import 时抛错 → 发现失败，并保留原始错误信息。
6. 扫描目录外路径 → 默认 API 不接受，测试确认没有任意路径入口。

**行为回归测试**：

- `toolSchemasForChat` 四种组合的名称顺序与基线一致。
- Guard 允许 4 个工具，拒绝未知工具。
- Realtime / KB / Action 三个 Worker 的过滤结果正确。
- MCP 暴露集合为 3 个工具，`draft_message` 不在其中。

**测试数据建议**：

- 临时目录用 `mkdtemp` 创建。
- 假模块写成 `.mjs`，避免把故意非法的 TypeScript fixture 放进 `tsconfig`。
- 每个用例使用独立目录，避免动态 import 缓存互相影响。

**命令**：

```bash
npx tsx --test server/tools/*.test.ts
npm run typecheck
npm run build
```

**验收**：

- 所有正向、负向和回归测试通过。
- 测试不依赖真实模型和 API Key。

---

### 步骤组 6：完整回归与文档收尾

**回归命令**：

```bash
npm run typecheck
npm run build
npm run mcp:ping
npm run eval:chat
npm run eval:multi
```

**说明**：

- `mcp:ping` 会起 MCP 子进程，验证工具列表和实际调用。
- `eval:chat` / `eval:multi` 需要真实模型；没有 API Key 或 `MOCK_MODE=1` 时，
  明确记录“未运行”，不要写成通过。
- 如果网络或模型不可用，至少完成 typecheck、build、discover 测试和 MCP ping。

**文档更新**：

- `tools/README.md`：新增工具步骤改为“只加一个模块目录”。
- `docs/dynamic-tool-discovery.md`：把“当前仍是静态注册表”改为实际实现状态，
  补充最终文件结构和与设计稿的差异。
- `tasks/todo.md`：勾选 8.1～8.10 和检查点 8，写明实际验证结果。
- `tasks/plan.md`：更新“当前代码事实”和完成状态。

**验收**：

- 文档中的新增工具步骤与实际代码一致。
- `todo.md` 的勾选有对应命令结果，不是只写“已完成”。
- 没有把未运行的 Evals 标成通过。

---

## 9. 验收标准

### 9.1 功能

- 新增工具只增加一个模块目录。
- Guard 白名单、MCP 注册、Chat schema 不再手抄工具名。
- 现有 4 个工具的调用行为与改造前一致。
- Worker 仍按显式 tag 隔离工具。

### 9.2 失败路径

- 缺 `run`、重名、schema 名字不一致、非法 tag、import 抛错都会启动失败。
- 错误信息包含模块名和缺失字段，不包含绝对路径。
- 未知工具仍被 Guard 拒绝。
- 过滤后为空的 Worker 不会带着空工具集继续请求模型。

### 9.3 可观测性

- 启动日志包含发现数量、工具名、tags、risk、MCP 暴露状态。
- 发现失败时能定位到具体模块。
- 不打印绝对路径。

### 9.4 回归

- `npm run typecheck` 通过。
- `npm run build` 通过。
- `npx tsx --test server/tools/*.test.ts` 通过。
- `npm run mcp:ping` 通过。
- 单 Agent、多 Agent、人工确认路径行为不变。
- Evals 实际结果如实记录。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 顶层 await 与循环依赖 | 模块初始化卡住或注册表未完成 | 模块禁止 import `tools/index.ts`；发现循环立即回退显式初始化 |
| 动态 import 路径在部署环境不同 | 生产环境发现不到模块 | 只接受固定目录；同时支持 `index.ts` / `index.js`；测试两种后缀 |
| 坏模块导致整个服务起不来 | 本地开发中断 | 这是有意的 fail-fast；错误必须精确到模块名和字段 |
| 重名工具悄悄覆盖 | 调用了错误实现 | 注册时检测重复并抛错 |
| Worker 看到不该看的工具 | 多 Agent 边界被破坏 | tags 显式过滤；负向测试断言可见集 |
| MCP 与 Chat schema 不一致 | 同一工具两套参数 | MCP 入参与模块同目录维护；`mcp:ping` 回归 |
| 迁移时同时改业务逻辑 | 回归失败难定位 | 每个阶段只做一类改动；先结构、后行为 |
| 文档路径泄露 | 违反路径隐私规则 | 日志和错误只打印模块目录名 |

---

## 11. 建议的执行节奏

按 5 个小节推进，每节结束都能独立验证：

1. **盘点 + Guard 派生**：最小改动，先证明“清单同源”可行。
2. **ToolModule + 4 个模块迁移**：只改注册结构，不改工具行为。
3. **discover + registry + 测试**：启用目录扫描，补齐正向/负向测试。
4. **MCP + 三个 Worker + 确认名单**：删除剩余手工清单。
5. **完整回归 + 文档 + todo**：证明行为等价并沉淀结论。

每节完成后暂停确认，不一次性铺开。

---

## 12. 开工前的默认决策

如果用户没有额外指定，按以下默认值执行：

- 第一个改动只做步骤组 1（`listToolNames()` + Guard），不直接上目录扫描。
- 本轮迁移全部 4 个工具。
- MCP 仍只暴露 3 个工具，`draft_message` 不暴露。
- 先组合旧 schema/method，不立即搬家业务实现。
- 不保留 static/discover 双运行时开关。
- 不使用生产玩具工具做验证，正向测试用临时 fixture。
- 所有新增文档和日志遵守路径隐私规则。

---

## 13. 一句话总结

> 现在的问题是“工具能力写在文件里，清单抄在多处”；
> 这次改造用固定目录发现生成唯一清单，再派生 Guard、Chat、MCP 和 Worker 可见集。
> 自动发现只解决清单同步，Worker 的权限边界仍然显式保留。
