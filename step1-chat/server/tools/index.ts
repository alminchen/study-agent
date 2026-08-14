import type { ToolDefinition } from "./types.js";
import { currentTimeToolDef } from "./time.js";
import { weatherToolDef } from "./weather.js";

const toolList: ToolDefinition[] = [weatherToolDef, currentTimeToolDef];

const toolByName = new Map(toolList.map((tool) => [tool.name, tool]));

export const toolSchemas = toolList.map((tool) => tool.schema);

export function findTool(name: string): ToolDefinition | undefined {
  return toolByName.get(name);
}
