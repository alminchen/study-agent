import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStep1McpServer } from "./createServer.js";

/**
 * MCP 侧回归：注册表派生的工具集要能真正把入参传进 run。
 * 这里走真实的 MCP 协议链路（listTools / callTool），不直接调内部 handler。
 */
test("MCP 工具集由注册表派生且入参可传达", async () => {
  const server = createStep1McpServer();
  const client = new Client({ name: "mcp-test", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["getCurrentTime", "getWeather", "searchDocs"]);
  assert.equal(names.includes("draft_message"), false);

  const weather = listed.tools.find((tool) => tool.name === "getWeather");
  assert.deepEqual(weather?.inputSchema?.required, ["city"]);
  assert.equal(
    Object.keys(weather?.inputSchema?.properties ?? {}).includes("city"),
    true,
  );

  const time = listed.tools.find((tool) => tool.name === "getCurrentTime");
  assert.deepEqual(time?.inputSchema?.properties, {});

  const result = await client.callTool({
    name: "getWeather",
    arguments: { city: "广州" },
  });
  assert.equal(result.isError, false);
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.equal(text.includes("广州"), true);
  assert.equal(text.includes("缺少参数 city"), false);

  await client.close();
  await server.close();
});
