import type { ToolDefinition } from "./types.js";
import { isToolRequiringConfirm } from "../react/toolsRequiringConfirm.js";
import { draftMessageTool } from "./schemas/draftMessage.js";
import { searchDocsTool } from "./schemas/searchDocs.js";
import { getCurrentTimeTool } from "./schemas/time.js";
import { getWeatherTool } from "./schemas/weather.js";
import { runDraftMessage } from "./methods/draftMessage.js";
import { runSearchDocs } from "./methods/searchDocs.js";
import { runGetCurrentTime } from "./methods/time.js";
import { runGetWeather } from "./methods/weather.js";

/**
 * 工具注册表：把「调用定义」和「执行方法」粘在一起。
 *
 * 新增工具步骤：
 * 1. schemas/ 加 Function Calling 定义
 * 2. methods/ 加 run
 * 3. 登记进 toolList
 * 4. 若有后果 → toolsRequiringConfirm + toolCallGuard 白名单
 * 5. 聊天对接前：需确认工具不要进 toolSchemasForChat（见下方 filter）
 *
 * 详见 docs/human-confirm-changelog.md、docs/dynamic-tool-discovery.md
 */
const toolList: ToolDefinition[] = [
  { name: "getWeather", schema: getWeatherTool, run: runGetWeather },
  { name: "getCurrentTime", schema: getCurrentTimeTool, run: runGetCurrentTime },
  { name: "searchDocs", schema: searchDocsTool, run: runSearchDocs },
  // 有后果假工具：已注册可 findTool，但暂不挂给聊天模型（filter 掉）
  { name: "draft_message", schema: draftMessageTool, run: runDraftMessage },
];

const toolByName = new Map(toolList.map((tool) => [tool.name, tool]));

/**
 * 发给模型的 tools 列表（聊天 / ReAct 用）。
 *
 * - includeSearchDocs=false → 去掉 searchDocs
 * - post-learning 语义 C：`/api/chat` 的 requestCompletion **固定传 false**
 *   （勾选知识库只走 prefetch，不把 searchDocs 交给模型）
 * - includeConfirmTools=false → 去掉需人工确认的工具（未建 ConfirmSession 时不应暴露）
 * - 聊天对接后：有 ConfirmSession 时传 includeConfirmTools=true
 * - MCP / kbWorker 等仍可直接 findTool("searchDocs")，不受本函数影响
 */
export function toolSchemasForChat(includeSearchDocs: boolean, includeConfirmTools = false) {
  return toolList
    .filter((tool) => includeSearchDocs || tool.name !== "searchDocs")
    .filter((tool) => includeConfirmTools || !isToolRequiringConfirm(tool.name))
    .map((tool) => tool.schema);
}

/**
 * 全部工具 schema（含 draft_message）。
 * 一般不直接喂给 /api/chat；用于调试或将来 MCP/Evals 显式枚举。
 */
export const toolSchemas = toolList.map((tool) => tool.schema);

/**
 * 按模型给出的函数名找到本地实现。
 * 找不到则上层回填「未知工具」；需确认工具在名单内时仍能 find 到并 run（确认通过后）。
 */
export function findTool(name: string): ToolDefinition | undefined {
  return toolByName.get(name);
}
