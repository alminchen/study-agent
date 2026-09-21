import type { ToolSchema } from "../types.js";

/** 何时调、参数是什么——写在这里，不写进 chat 的 system。 */
export const getCurrentTimeTool: ToolSchema = {
  type: "function",
  function: {
    name: "getCurrentTime",
    description:
      "查询当前日期与时间。适用：现在几点、几点了、当前时间、今天几号、顺便查查几点、北京时间。" +
      "只要用户在问「几点」「什么时间」「今天日期」，就必须调用本工具，不要凭记忆直接回答。",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
};
