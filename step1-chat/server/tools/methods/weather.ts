/** 模型调用 getWeather 时必须带上的参数 */
export interface GetWeatherArgs {
  city: string;
}

/** 程序执行 getWeather 后得到的数据（mock） */
export interface WeatherResult {
  city: string;
  temperature: string;
  condition: string;
  humidity: string;
}

/** 把模型给的 arguments 字符串解析成 city；不合法就返回 error，不抛错。 */
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

/** 明显不是地球城市：拒绝查询，不编造天气。广州、杭州等地球城市不在此列。 */
const NOT_EARTH_CITIES = [
  "火星",
  "月球",
  "金星",
  "木星",
  "土星",
  "水星",
  "海王星",
  "天王星",
  "太阳",
  "mars",
  "moon",
  "venus",
  "jupiter",
  "saturn",
  "mercury",
  "neptune",
  "uranus",
  "sun",
];

const PRESET_WEATHER: Record<string, Omit<WeatherResult, "city">> = {
  北京: { temperature: "28°C", condition: "晴", humidity: "42%" },
  上海: { temperature: "24°C", condition: "多云", humidity: "55%" },
};

const CONDITIONS = ["晴", "多云", "阴", "小雨"] as const;

function isNotEarthCity(city: string): boolean {
  const key = city.trim().toLowerCase();
  return NOT_EARTH_CITIES.some((name) => name.toLowerCase() === key);
}

/** 同一城市每次查到的假数据相同，换城市数值会变。 */
function mockWeatherForCity(city: string): WeatherResult {
  const preset = PRESET_WEATHER[city];
  if (preset) {
    return { city, ...preset };
  }
  let seed = 0;
  for (const char of city) {
    seed += char.charCodeAt(0);
  }
  return {
    city,
    temperature: `${18 + (seed % 15)}°C`,
    condition: CONDITIONS[seed % CONDITIONS.length],
    humidity: `${35 + (seed % 40)}%`,
  };
}

/**
 * 地球城市返回 mock 天气；火星等天体返回 error。
 * 不维护城市白名单，避免广州、杭州也被拦住。
 */
export function executeGetWeather(args: GetWeatherArgs): WeatherResult | { error: string } {
  if (isNotEarthCity(args.city)) {
    return { error: `「${args.city}」不是地球上的城市，无法查询天气` };
  }
  return mockWeatherForCity(args.city);
}

/** 给 findTool 用：解析参数失败也返回 `{ error }`，不往外 throw。 */
export function runGetWeather(rawArguments: string): unknown {
  const parsed = parseGetWeatherArgs(rawArguments);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return executeGetWeather(parsed.args);
}
