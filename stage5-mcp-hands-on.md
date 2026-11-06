# 阶段 5 · 第一课 · MCP 动手计划

> 只做一件事：起一个 TypeScript MCP，把现有 `run*` 接进去。  
> **不改** `/api/chat`、LangGraph、前端。聊天页切到 MCP 是下一小段。

## 你要先建立的对应关系

| 现在（项目内部） | MCP（对外协议） |
|---|---|
| Express `/api/chat` | 一个 MCP **server 进程** |
| `tools/index.ts` 的 `toolList` | `McpServer` 上登记多个 **tool** |
| `schemas/*.ts`（给模型看的描述） | `registerTool` / `tool()` 的 name + description + inputSchema |
| `methods/*.ts` 的 `run*` | tool 的 **handler**，原样调用 |
| 前端过程面板 | 不属于 MCP（页面逻辑） |

一句话：**MCP 只换“怎么被调用”，不换“工具怎么执行”。**

## 三层不要混

1. **页面**：勾选「搜索知识库」、SSE、过程面板
2. **协议**：stdio 上的 JSON-RPC（MCP）
3. **执行**：`runGetWeather` / `runGetCurrentTime` / `runSearchDocs`

handler 里只做：把 MCP 传来的对象 `JSON.stringify` 交给现有 `run`，再把结果包成 MCP 的 `content`。

## 动手顺序

### 1. 装 SDK

学习用稳定的 v1 包（Cursor `mcp.json` 最常见）：

```bash
npm install @modelcontextprotocol/sdk zod
```

入口进程必须走 **stdio**。日志只能 `console.error`，不能 `console.log`——stdout 被协议占用。

### 2. 起 server（薄适配）

文件：

- `server/mcp/createServer.ts`：`new McpServer` + 登记工具
- `server/mcp/stdio.ts`：`StdioServerTransport` 连上进程

一个 server 里挂多个方法，对应你已经有的 `toolList`。

接 `run` 的固定写法：

```ts
const result = await runGetWeather(JSON.stringify({ city }));
return { content: [{ type: "text", text: JSON.stringify(result) }] };
```

`run*` 仍然吃「参数字符串」，校验、火星拒绝、检索门槛都还在 `methods/` 里。

### 3. 本地验（先别接 Cursor）

```bash
npm run mcp:ping
```

应看到 `listTools` 里有 `getWeather` / `getCurrentTime` / `searchDocs`，并且 `getCurrentTime` 能返回真实时间。

也可用官方 Inspector：

```bash
npx @modelcontextprotocol/inspector npx tsx server/mcp/stdio.ts
```

### 4. （可选）接到 Cursor

`~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`（**不要用 `npx tsx`，Cursor 里经常找不到模块**）：

```json
{
  "mcpServers": {
    "step1-chat": {
      "command": "/usr/local/bin/node",
      "args": [
        "<项目根绝对路径>/node_modules/tsx/dist/cli.mjs",
        "<项目根绝对路径>/server/mcp/stdio.ts"
      ],
      "cwd": "<项目根绝对路径>"
    }
  }
}
```

连上后，Cursor 里的 Agent 也能调这组工具。这证明「工具不再只属于聊天页」。

> 各客户端（Cursor / Claude Desktop / VS Code / Codex / Claude Code）的完整配置写法、
> 暴露哪些工具、验证步骤与常见坑，见
> [step1-chat/docs/mcp-usage.md](step1-chat/docs/mcp-usage.md)。

### 5. 明确先不做

- 不要让 `runConversation` 改去调 MCP
- 不要拆成三个 MCP server
- 不要上 Tracing / Evals / 部署

## 验收

- [ ] `npm run mcp:ping`：列出 3 个工具，时间工具有结果
- [ ] 调 `getWeather`，地球城市有 mock 天气；火星返回 `{ error }`
- [ ] `searchDocs` 仍走 `retrieveForAnswer`（冷启动会慢，属正常）
- [ ] `/api/chat` 行为不变
