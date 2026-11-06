import type { ToolModule } from "../../types.js";
import { getCurrentTimeTool } from "../../schemas/time.js";
import { runGetCurrentTime } from "../../methods/time.js";

export const tool: ToolModule = {
  name: "getCurrentTime",
  schema: getCurrentTimeTool,
  run: runGetCurrentTime,
  tags: ["realtime"],
  risk: "read",
  includeInDefaultChat: true,
  mcp: { expose: true, inputSchema: {} },
};
