import type { ToolSchema } from "../types.js";

/**
 * 勾选「搜索知识库」时会出现在发给模型的 tools 里。
 * 何时调、参数是什么——写在这里，不写进 chat 的 system。
 */
export const searchDocsTool: ToolSchema = {
  type: "function",
  function: {
    name: "searchDocs",
    description:
      "在本地知识库中检索。仅当用户问题需要查已入库资料时使用；question 填检索问句，一般用用户原话。" +
      "不用于天气、当前时间。",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "知识库检索问句",
        },
      },
      required: ["question"],
    },
  },
};
