/** 模型调用 getWeather 时必须带上的参数 */
export interface GetWeatherArgs {
  city: string;
}

/** 程序执行 getWeather 后得到的数据（mock，对照 Demo 的 executeTool） */
export interface WeatherResult {
  city: string;
  temperature: string;
  condition: string;
  humidity: string;
}

export function parseGetWeatherArgs(
  raw: string,
): { ok: true; args: GetWeatherArgs } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "getWeather 参数不是合法 JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: 'getWeather 参数必须是对象，例如 {"city":"北京"}' };
  }

  const city = (parsed as { city?: unknown }).city;
  if (typeof city !== "string" || city.trim() === "") {
    return { ok: false, error: "缺少参数 city，需要提供城市名称，例如 {\"city\":\"北京\"}" };
  }

  return { ok: true, args: { city: city.trim() } };
}

export function executeGetWeather(args: GetWeatherArgs): WeatherResult {
  const city = args.city;
  return {
    city,
    temperature: city === "北京" ? "28°C" : "24°C",
    condition: city === "北京" ? "晴" : "多云",
    humidity: city === "北京" ? "42%" : "55%",
  };
}

import type { ToolDefinition } from "./types.js";

/**
 * 发给模型的 tools 项（OpenAI 兼容格式）。
 * 对应 Demo 里的 TOOL_SCHEMAS.getWeather，只是字段更标准。
 */
export const getWeatherTool = {
  type: "function",
  function: {
    name: "getWeather",
    description: "查询某个城市今天的天气情况",
    parameters: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "城市名称，例如：北京、上海",
        },
      },
      required: ["city"],
    },
  },
} as const;

export const weatherToolDef: ToolDefinition = {
  name: "getWeather",
  schema: getWeatherTool,
  run(rawArguments) {
    const parsed = parseGetWeatherArgs(rawArguments);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    return executeGetWeather(parsed.args);
  },
};
