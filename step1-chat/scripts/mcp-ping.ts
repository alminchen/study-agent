import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * 本地验收：起 MCP 子进程，列出工具并各调一次。
 * 不经过聊天页，用来证明「现有 run 已经能被标准协议调用」。
 */
async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "server/mcp/stdio.ts"],
  });
  const client = new Client({ name: "step1-mcp-ping", version: "0.1.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  console.log("tools:", listed.tools.map((tool) => tool.name).join(", "));

  const time = await client.callTool({ name: "getCurrentTime", arguments: {} });
  console.log("getCurrentTime:", JSON.stringify(time));

  const weather = await client.callTool({
    name: "getWeather",
    arguments: { city: "广州" },
  });
  console.log("getWeather:", JSON.stringify(weather));

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
