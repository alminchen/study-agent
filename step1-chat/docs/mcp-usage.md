# MCP 对外接入（MCP Server 使用文档）

> **一句话**：项目里的工具除了给自家聊天页用，还通过 **MCP 协议**暴露给外部 LLM 客户端
> （Cursor / Claude Desktop / VS Code / Codex / Claude Code …）。外部客户端和内部 Agent
> 调的是**同一批工具、同一套 `run` 实现**，只是「怎么被调用」换成了标准协议。

| 配套 | 位置 |
|------|------|
| 注册表侧流程图 | [dynamic-tool-discovery-flow.svg](./dynamic-tool-discovery-flow.svg) |
| 方法级拓扑 | [project-topology.html §7b](./project-topology.html#tools) |
| 概念教学页 | [../Code/server/tools-mcp.html](../Code/server/tools-mcp.html) |
| 源码 | `server/mcp/` · `server/tools/` |

---

## 1. 它和 `/api/chat` 的关系

| | 内部 Agent（聊天页） | 外部客户端（MCP） |
|---|---|---|
| 入口 | `POST /api/chat` | 客户端 spawn 起的 MCP 子进程 |
| 拿到工具的方式 | `toolSchemasForChat()` 取 schema | `tools/list` 拉工具清单 |
| 调用方式 | **直调** 注册表里的 `run` | **MCP 协议**（stdio JSON-RPC） |
| 协议开销 | 无 | 有序列化 + 协议封装 |
| 适合 | 站内多 Agent 协作、需要 Guard / Trace / 人工确认 | 通用工具服务、跨工具生态 |

一句话：**MCP 只换「怎么被调用」，不换「工具怎么执行」**。
`run` 里的参数校验、Guard、检索门槛全部照旧生效。

---

## 2. 代码位置

| 文件 | 职责 |
|------|------|
| `server/mcp/createServer.ts` | 建 `McpServer`，遍历注册表把工具注册进去 |
| `server/mcp/stdio.ts` | **进程入口**：读 `.env` → `StdioServerTransport` → connect |
| `server/mcp/createServer.test.ts` | 走真实 MCP 协议链路的测试（`listTools` / `callTool`） |
| `scripts/mcp-ping.ts` | 本地验收脚本：起子进程、列工具、各调一次 |

---

## 3. 原理：客户端配置为什么是「三件套」

外部客户端接 stdio 型 MCP server 的方式只有一个：**它把配置里的命令跑起来当子进程，
然后用这个进程的 stdin/stdout 说 JSON-RPC**。所以配置里必须说清三件事：

| 键 | 含义 | 本项目填什么 | 填错的后果 |
|----|------|--------------|------------|
| `command` | 用哪个可执行文件起进程 | `node`（或 node 的绝对路径） | 客户端 PATH 干净 → `command not found` |
| `args` | 传给它的参数 | `tsx` 的 cli 路径 + `server/mcp/stdio.ts` | 模块解析不到 → 起不来 |
| `cwd` | 工作目录 | **项目根目录** | 读不到 `.env` / `.env.local` → key 全空 |

> 为什么 `cwd` 必须是项目根：`server/mcp/stdio.ts` 里是
> `dotenv.config({ path: ".env.local" })` 这类**相对路径**，工作目录一偏就静默读不到配置。

> 为什么不用 `npx tsx`：客户端 spawn 子进程时 PATH 往往极简，`npx` 常找不到；
> 直接指向 `node_modules/tsx/dist/cli.mjs` 最稳。

---

## 4. 客户端配置写法

### 4.1 通用 JSON（大多数客户端通用这一段）

```json
{
  "mcpServers": {
    "step1-chat": {
      "command": "node",
      "args": ["<项目根绝对路径>/node_modules/tsx/dist/cli.mjs",
               "<项目根绝对路径>/server/mcp/stdio.ts"],
      "cwd": "<项目根绝对路径>"
    }
  }
}
```

`<项目根绝对路径>` = 本仓库 `step1-chat` 目录的绝对路径。
下面这条命令会**直接把填好的 JSON 打出来**，复制即可，不用手拼路径：

```bash
cd step1-chat
ROOT=$(pwd)
node -e '
const r = process.argv[1];
console.log(JSON.stringify({
  mcpServers: {
    "step1-chat": {
      command: process.execPath,
      args: [r + "/node_modules/tsx/dist/cli.mjs", r + "/server/mcp/stdio.ts"],
      cwd: r
    }
  }
}, null, 2));
' "$ROOT"
```

### 4.2 Cursor

配置文件：项目级 `.cursor/mcp.json`（新建），或全局 `~/.cursor/mcp.json`。
用 §4.1 的 JSON 原样即可。

### 4.3 Claude Desktop（macOS）

配置文件：`~/Library/Application Support/Claude/claude_desktop_config.json`
（Windows：`%APPDATA%\Claude\claude_desktop_config.json`）。

键名同样是 `mcpServers`，用 §4.1 的 JSON。
改完**完全退出 Claude Desktop 再重开**才生效。

### 4.4 VS Code / Copilot

配置文件：项目 `.vscode/mcp.json`。
新版键名是 `servers`，老版本用 `mcpServers`，两种都认：

```json
{
  "servers": {
    "step1-chat": {
      "type": "stdio",
      "command": "node",
      "args": ["<项目根绝对路径>/node_modules/tsx/dist/cli.mjs",
               "<项目根绝对路径>/server/mcp/stdio.ts"],
      "cwd": "<项目根绝对路径>"
    }
  }
}
```

### 4.5 Codex

配置文件：`~/.codex/config.toml`。**Codex 用 TOML，不是 JSON**：

```toml
[mcp_servers.step1-chat]
command = "node"
args = ["<项目根绝对路径>/node_modules/tsx/dist/cli.mjs",
        "<项目根绝对路径>/server/mcp/stdio.ts"]
cwd = "<项目根绝对路径>"
```

加完重启 Codex，在设置里能看到 `step1-chat` 这个 server 和它带的工具。

### 4.6 Claude Code

配置文件：`~/.claude/mcp.json`（键名 `mcpServers`），或用 CLI 直接加：

```bash
claude mcp add step1-chat -- \
  node <项目根绝对路径>/node_modules/tsx/dist/cli.mjs \
      <项目根绝对路径>/server/mcp/stdio.ts
```

---

## 5. 对外暴露哪些工具

MCP 工具集 = 注册表里的 `toolsWithMcp()`，也就是**声明了 `mcp.expose: true` 的模块**：

| 工具 | tags | risk | 对外 |
|------|------|------|------|
| `getCurrentTime` | realtime | read | ✅ |
| `getWeather` | realtime | read | ✅ |
| `searchDocs` | kb | read | ✅ |
| `draft_message` | action | confirm | ❌ 内部动作工具，不对外 |

`draft_message` 是发给用户看的「起草回复」，语义上属于站内动作，
外部客户端拿到它也不知道该往哪儿发，所以 `mcp.expose: false`。

---

## 6. 验证

### 6.1 本地自检（先做这步）

```bash
npm run mcp:ping
```

期望输出（工具清单 + 两次真实调用结果）：

```text
tools: getCurrentTime, getWeather, searchDocs
getCurrentTime: {"content":[{"type":"text","text":"..."}]}
getWeather: {"content":[{"type":"text","text":"{\"city\":\"广州\",...}"}]}
```

### 6.2 官方 Inspector（图形界面逐个调）

```bash
npx @modelcontextprotocol/inspector npx tsx server/mcp/stdio.ts
```

### 6.3 客户端内

连接成功后，客户端的工具列表里应出现上表 3 个工具。
**连不上先回头查 §3 的三件套，九成是 `cwd` 没指到项目根。**

---

## 7. 五个坑

1. **`cwd` 没指到项目根** → `.env` / `.env.local` 读不到，`searchDocs` 与 LLM 相关 key 全空。
2. **用了 `npx tsx`** → 客户端 PATH 里常找不到模块，进程起不来。
3. **`command` 写 `node` 但客户端 PATH 不含它** → 报 `command not found`，
   换成 `which node` 的输出即可。
4. **stdout 被日志污染** → stdio 传输的 stdout 被 JSON-RPC 独占，
   所以这个进程里**只能 `console.error`**，多一句 `console.log` 协议就废。
5. **`searchDocs` 首次调用慢** → embedding / rerank 走本地 ONNX 模型，
   第一次要加载模型文件，属正常，不是坏了。

---

## 8. 加一个新工具到 MCP（阶段 5 的红利）

阶段 5 之后，**加工具不用碰 MCP 代码**：

1. 新建 `server/tools/modules/<name>/index.ts`，导出 `schema` / `run` / `tags` / `risk`；
2. 需要入参就声明 `mcp.inputSchema`（zod shape，MCP 协议要这个；
   `schema.function.parameters` 是给模型看的 JSON Schema，**两者不是同一种格式**）；
3. 对外暴露就设 `mcp: { expose: true, inputSchema }`，不暴露就 `expose: false`；
4. 启动时 `discoverTools()` 校验 → `createRegistry()` 派生 → MCP 自动注册。

详见 [dynamic-tool-discovery.md](./dynamic-tool-discovery.md)。

---

## 9. 相关文档

- 工具动态发现（注册表怎么来的）：[dynamic-tool-discovery.md](./dynamic-tool-discovery.md)
- 方法级拓扑 §7b：[project-topology.html](./project-topology.html#tools)
- MCP 概念教学页：[../Code/server/tools-mcp.html](../Code/server/tools-mcp.html)
- 工具注册表 API：[../server/tools/README.md](../server/tools/README.md)
