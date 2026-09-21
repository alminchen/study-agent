import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStep1McpServer } from "./createServer.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/**
 * MCP 入口：Cursor / Inspector 会 spawn 这个进程，用 stdin/stdout 说话。
 * 日志只能打到 stderr，否则会弄脏 JSON-RPC。
 */
async function main() {
  const server = createStep1McpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("step1-chat MCP server running on stdio");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
