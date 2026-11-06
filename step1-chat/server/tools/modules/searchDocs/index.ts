import { z } from "zod";
import type { ToolModule } from "../../types.js";
import { searchDocsTool } from "../../schemas/searchDocs.js";
import { runSearchDocs } from "../../methods/searchDocs.js";

export const tool: ToolModule = {
  name: "searchDocs",
  schema: searchDocsTool,
  run: runSearchDocs,
  tags: ["kb"],
  risk: "read",
  includeInDefaultChat: false,
  mcp: {
    expose: true,
    inputSchema: {
      question: z.string().describe("知识库检索问句"),
    },
  },
};
