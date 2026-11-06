# server/tools/schemas/ — 给模型看的工具定义

> 所属学习阶段：**阶段 2 · 让模型会做事** + **阶段 4 · 知识库检索工具** + **进阶学习第 5 项 · Tool 动态发现**
> 上级说明：[`server/tools/README.md`](../README.md) · 阶段总结：[`docs/dynamic-tool-discovery.md`](../../../docs/dynamic-tool-discovery.md)

## 模块职责

每个文件导出一个 `ToolSchema`——OpenAI 兼容的 Function Calling 定义，回答两件事：

1. **这个工具能干什么、什么时候该调**（写进 `function.description`）
2. **调用时要传哪些参数**（写进 `function.parameters`）

只描述，不执行。任何本地业务逻辑都不许写在这里——执行在 [`methods/`](../methods/README.md)，粘合在 [`modules/`](../modules/README.md)。

> 原则：**何时调、参数是什么——写在这里，不写进 chat 的 system。**
> 工具说明放 schema 里，模型每次请求都带着它；放 system 里则要靠系统提示词维持，容易互相打架。

## 文件说明

| 文件 | 导出 | 工具名 | 参数 | 要点 |
|------|------|--------|------|------|
| `weather.ts` | `getWeatherTool` | `getWeather` | `city`（必填，string） | description 明确「不适用火星/太阳等天体」 |
| `time.ts` | `getCurrentTimeTool` | `getCurrentTime` | 无（`properties: {}`，`additionalProperties: false`） | description 强调「问几点必须调工具，不要凭记忆」 |
| `searchDocs.ts` | `searchDocsTool` | `searchDocs` | `question`（必填，string） | description 限定「仅当问题需要查已入库资料时使用」 |
| `draftMessage.ts` | `draftMessageTool` | `draft_message` | `to`、`body`（均必填，string） | 学习用假工具，真实外发本期不做 |

## 写作约定

- **一文件一工具**：文件名跟随工具名风格（`draft_message` 用下划线，其余用小驼峰）。
- **`function.name` 必须等于模块的 `name`**：启动期校验会查，不一致直接启动失败。
- **description 写触发条件，不写实现细节**：模型据此决定调不调；实现细节是 `methods/` 的事。
- **`parameters` 是 JSON Schema**（`type` / `properties` / `required` / `additionalProperties`），给模型看；
  MCP 端要用的 zod 入参另写一份 `mcp.inputSchema`，见 [`modules/README.md`](../modules/README.md)。
- **改了 schema 就是在改模型行为**：描述、参数名、必填项一变，模型的调用习惯就可能变。

## 校验方式

`function.name` 与模块 `name` 的一致性、以及 tags / risk 等元数据，
由启动期校验统一把关（见 [`modules/README.md`](../modules/README.md)）。
相关测试：`server/tools/discovery.test.ts`、`server/tools/toolRegistry.test.ts`。
