import type { ToolDefinition, ToolModule, ToolTag } from "./types.js";

export interface ToolRegistry {
  tools: ToolModule[];
  toolSchemas: ToolDefinition["schema"][];
  findTool: (name: string) => ToolDefinition | undefined;
  listTools: () => ToolDefinition[];
  listToolNames: () => string[];
  toolsWithTags: (tags: readonly ToolTag[]) => ToolDefinition[];
  toolsWithMcp: () => ToolModule[];
  isToolRequiringConfirm: (name: string) => boolean;
  toolSchemasForChat: (
    includeSearchDocs: boolean,
    includeConfirmTools?: boolean,
  ) => ToolDefinition["schema"][];
}

export function createRegistry(tools: ToolModule[]): ToolRegistry {
  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
  if (toolByName.size !== tools.length) {
    const duplicates = tools
      .map((tool) => tool.name)
      .filter((name, index, names) => names.indexOf(name) !== index);
    throw new Error(`工具名重复：${[...new Set(duplicates)].join("、")}`);
  }

  return {
    tools,
    toolSchemas: tools.map((tool) => tool.schema),
    findTool: (name) => toolByName.get(name),
    listTools: () => [...tools],
    listToolNames: () => tools.map((tool) => tool.name),
    toolsWithTags: (tags) =>
      tools.filter((tool) => tags.some((tag) => tool.tags.includes(tag))),
    toolsWithMcp: () => tools.filter((tool) => tool.mcp?.expose === true),
    isToolRequiringConfirm: (name) => tools.some((tool) => tool.name === name && tool.risk === "confirm"),
    toolSchemasForChat(includeSearchDocs, includeConfirmTools = false) {
      return tools
        .filter((tool) => includeSearchDocs || tool.name !== "searchDocs")
        .filter((tool) => includeConfirmTools || tool.risk !== "confirm")
        .map((tool) => tool.schema);
    },
  };
}
