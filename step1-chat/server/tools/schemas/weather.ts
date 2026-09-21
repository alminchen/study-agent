import type { ToolSchema } from "../types.js";

/**
 * 何时调、参数是什么——写在这里，不写进 chat 的 system。
 */
export const getWeatherTool: ToolSchema = {
  type: "function",
  function: {
    name: "getWeather",
    description:
      "查询某座地球城市今天的天气或气温。适用：广州的天气、深圳今天天气、北京多少度、XX市气温怎么样。" +
      "调用时 city 填城市名（如广州、深圳）。不适用：火星/太阳等天体。",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "城市名称，例如深圳、北京、广州",
        },
      },
      required: ["city"],
    },
  },
};
