import type { ToolModule } from "../../types.js";
import { draftMessageTool } from "../../schemas/draftMessage.js";
import { runDraftMessage } from "../../methods/draftMessage.js";

export const tool: ToolModule = {
  name: "draft_message",
  schema: draftMessageTool,
  run: runDraftMessage,
  tags: ["action"],
  risk: "confirm",
  includeInDefaultChat: true,
};
