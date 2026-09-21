# server/mcp/ — MCP Server（Model Context Protocol）

> 所属学习阶段：**阶段 5 · MCP**
> 学习计划文档：`stage5-mcp-learning-plan.md`、`stage5-mcp-hands-on.md`

## 模块职责

用 TypeScript 暴露业务工具（getWeather、getCurrentTime、searchDocs）给外部 LLM 客户端通过 MCP 协议调用。

## 文件说明

| 文件 | 职责 |
|------|------|
| `createServer.ts` | 创建 MCP Server 实例，注册工具 |

## 与 /api/chat 的关系

- `/api/chat` 是内部 Agent 自己调用工具
- MCP Server 是让外部客户端（如 Cursor、其他 Agent）通过标准协议调用同一套工具
