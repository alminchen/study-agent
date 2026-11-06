# server/mcp/ — MCP Server（Model Context Protocol）

> 所属学习阶段：**阶段 5 · MCP / 工具动态发现**
> **完整使用文档（含外部客户端配置写法）：[../../docs/mcp-usage.md](../../docs/mcp-usage.md)**

## 模块职责

用 TypeScript 暴露业务工具（getWeather、getCurrentTime、searchDocs）给外部 LLM 客户端
通过 MCP 协议调用。工具清单不是手写的，来自工具注册表的 `toolsWithMcp()`。

## 文件说明

| 文件 | 职责 |
|------|------|
| `createServer.ts` | 建 `McpServer`，遍历 `toolsWithMcp()` 注册工具 |
| `stdio.ts` | **进程入口**：读 `.env` → `StdioServerTransport` → connect |
| `createServer.test.ts` | 走真实 MCP 协议链路的测试（`listTools` / `callTool`） |

本地验收脚本在 `scripts/mcp-ping.ts`。

## 怎么用

```bash
# 起服务（stdio，日志只能走 stderr）
npm run mcp:stdio

# 本地验收：列工具 + 各调一次
npm run mcp:ping
```

接外部客户端（Cursor / Claude Desktop / VS Code / Codex）要写三件套：
`command` + `args` + `cwd`，完整 JSON 和各客户端配置位置见
[docs/mcp-usage.md](../../docs/mcp-usage.md)。

## 与 /api/chat 的关系

- `/api/chat` 是内部 Agent 自己调用工具（直调注册表里的 `run`，不过协议）
- MCP Server 是让外部客户端（如 Cursor、其他 Agent）通过标准协议调用同一套工具
