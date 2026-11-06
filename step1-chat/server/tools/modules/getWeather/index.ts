import { z } from "zod";
import type { ToolModule } from "../../types.js";
import { getWeatherTool } from "../../schemas/weather.js";
import { runGetWeather } from "../../methods/weather.js";

export const tool: ToolModule = {
  name: "getWeather",
  schema: getWeatherTool,
  run: runGetWeather,
  tags: ["realtime"],
  risk: "read",
  includeInDefaultChat: true,
  mcp: {
    expose: true,
    inputSchema: {
      city: z.string().describe("城市名称，例如深圳、北京、广州"),
    },
  },
};
