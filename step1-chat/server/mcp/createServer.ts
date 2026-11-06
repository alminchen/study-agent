import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolsWithMcp } from "../tools/index.js";

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

  // 遍历注册表派生的 MCP 工具集进行注册
  for (const tool of toolsWithMcp()) {
    server.registerTool(
      tool.name,
      {
        description: tool.schema.function.description,
        // 没声明入参的工具也要给空 shape：否则 SDK 认为它「无参数」，
        // 回调第一个参数会变成 extra 而不是 args。
        inputSchema: (tool.mcp?.inputSchema ?? {}) as any,
      },
      async (args: any) => mcpFromRun(tool.run, args),
    );
  }

  return server;
}
