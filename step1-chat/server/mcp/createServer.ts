import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runSearchDocs } from "../tools/methods/searchDocs.js";
import { runGetCurrentTime } from "../tools/methods/time.js";
import { runGetWeather } from "../tools/methods/weather.js";
import { searchDocsTool } from "../tools/schemas/searchDocs.js";
import { getCurrentTimeTool } from "../tools/schemas/time.js";
import { getWeatherTool } from "../tools/schemas/weather.js";

/**
 * 把现有 run 的返回值包成 MCP 规定的 content。
 * 业务校验仍在 methods/；这里不重新判断城市、不重写检索。
 */
async function mcpFromRun(
  run: (rawArguments: string) => unknown | Promise<unknown>,
  args: unknown,
) {
  const result = await run(JSON.stringify(args ?? {}));
  const hasError = Boolean(result && typeof result === "object" && "error" in result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: hasError,
  };
}

/** 一个 MCP server，挂上现有三个工具。描述复用 schemas/，执行复用 methods/。 */
export function createStep1McpServer() {
  const server = new McpServer({ name: "step1-chat", version: "0.1.0" });

  // SDK 已弃用 server.tool() 的位置参数重载，统一用 registerTool(name, config, handler)。
  server.registerTool(
    "getWeather",
    {
      description: getWeatherTool.function.description,
      inputSchema: {
        city: z.string().describe("城市名称，例如深圳、北京、广州"),
      },
    },
    async ({ city }) => mcpFromRun(runGetWeather, { city }),
  );

  server.registerTool(
    "getCurrentTime",
    { description: getCurrentTimeTool.function.description },
    async () => mcpFromRun(runGetCurrentTime, {}),
  );

  server.registerTool(
    "searchDocs",
    {
      description: searchDocsTool.function.description,
      inputSchema: {
        question: z.string().describe("知识库检索问句"),
      },
    },
    async ({ question }) => mcpFromRun(runSearchDocs, { question }),
  );

  return server;
}
