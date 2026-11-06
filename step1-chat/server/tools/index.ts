import { discoverTools } from "./discover.js";
import { createRegistry } from "./registry.js";

/**
 * 工具注册表：启动时从固定 modules/ 目录发现，再派生所有清单。
 * 新增工具只需要建一个模块目录；校验失败在启动期暴露。
 */
const discovered = await discoverTools();
if (process.env.NODE_ENV !== "test") {
  console.log(
    `[tools] discovered count=${discovered.length} tools=${JSON.stringify(
      discovered.map((tool) => ({
        name: tool.name,
        tags: [...tool.tags],
        risk: tool.risk,
        mcp: tool.mcp?.expose === true,
      })),
    )}`,
  );
}
const registry = createRegistry(discovered);

export const toolList = registry.tools;
export const isToolRequiringConfirm = registry.isToolRequiringConfirm;
export const toolSchemas = registry.toolSchemas;

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
export const toolSchemasForChat = registry.toolSchemasForChat;
export const findTool = registry.findTool;
export const listTools = registry.listTools;
export const listToolNames = registry.listToolNames;
export const toolsWithTags = registry.toolsWithTags;
export const toolsWithMcp = registry.toolsWithMcp;
