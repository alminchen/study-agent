/**
 * 单元 2：无 LLM 的规则意图 / 槽位拆解。
 *
 * ## 为什么要有这一层
 * 口语短句直接 embed，语义焦点糊在一起（「广州今天天气」整句一个向量）。
 * 先拆成 intent + slots，后面扩写才不容易跑题；也能一眼看出规则能力边界。
 *
 * ## 做什么 / 不做什么
 * - 做：词典 + 简单包含匹配 → ParsedIntent 或 null
 * - 不做：调 LLM、调 retrieve、调 getWeather（拆槽位 ≠ 执行工具）
 *
 * ## 返回 null 的含义
 * 规则「没把握」——典型是开放域笔记问题（「chunk 怎么切」）。
 * 不要假自信写成 kb_search；交给单元 3 的 LLM。
 *
 * 学习计划：rag-query-intent-rewrite-learning-plan.md · 第二部分
 */

import type { IntentSlots, ParsedIntent, QueryIntent } from "./types.js";

/**
 * 教学用短名单：覆盖 demo 城市即可。
 * 生产要换地名库 / NER；本课重点是「槽位形态」，不是盖全国。
 */
const CITIES = [
  "北京",
  "上海",
  "广州",
  "深圳",
  "杭州",
  "成都",
  "重庆",
  "武汉",
  "西安",
  "南京",
  "苏州",
  "天津",
  "长沙",
  "郑州",
  "青岛",
  "厦门",
  "大连",
  "宁波",
  "福州",
  "济南",
];

/** 命中任一即倾向 weather（再结合城市 / 天体例外） */
const WEATHER_HINTS = ["天气", "气温", "温度", "下雨", "下雪", "冷不冷", "热不热", "多少度"];

/** 命中且无天气词 → time（「今天几号」） */
const TIME_HINTS = ["几点", "现在时间", "当前时间", "今天几号", "日期", "星期几"];

/** 整句等于这些才判闲聊，避免「你好吗，广州天气」误杀 */
const CHITCHAT_EXACT = ["你好", "您好", "嗨", "hi", "hello", "在吗", "谢谢", "再见"];

/**
 * 天体名：用户问「火星温度」时也有「温度」词，
 * 若走 weather 会抽出空 city 或乱填，污染后续扩写。应标 unknown。
 */
const NON_EARTH = ["火星", "月球", "太阳", "金星", "木星"];

/** 子串命中第一个城市（短名单无歧义足够；「南京路」类误伤本课忽略） */
function findCity(text: string): string | undefined {
  return CITIES.find((city) => text.includes(city));
}

/** 相对时间词；没有则 undefined，由调用方决定是否默认「现在」 */
function findTimeHint(text: string): string | undefined {
  if (/今天|今日/.test(text)) return "今天";
  if (/明天|明日/.test(text)) return "明天";
  if (/后天/.test(text)) return "后天";
  if (/昨天|昨日/.test(text)) return "昨天";
  return undefined;
}

function hitAny(text: string, hints: string[]): string[] {
  return hints.filter((h) => text.includes(h));
}

/**
 * 规则解析主入口。
 *
 * 判定顺序有意固定（先易后难、先例外后正向）：
 * 1. 空串 → null
 * 2. 整句闲聊 → chitchat
 * 3. 天体 + 天气词 → unknown（不要当地球天气）
 * 4. 天气词 → weather（尽量填 city/time）
 * 5. 时间词（且无天气）→ time
 * 6. 其余 → null（开放域，交给 LLM）
 *
 * 验收例句：
 * - 「广州今天天气」→ weather + city=广州
 * - 「火星温度」→ unknown，无 city
 * - 「你好」→ chitchat
 * - 「chunk 怎么切」→ null
 */
export function parseIntent(text: string): ParsedIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ---- 1) 闲聊：整句匹配，降低误伤 ----
  const lower = trimmed.toLowerCase();
  if (CHITCHAT_EXACT.some((w) => lower === w || trimmed === w)) {
    return {
      intent: "chitchat",
      slots: {},
      keywords: [],
      source: "rule",
    };
  }

  // ---- 2) 天体例外：有温度词也不走 weather ----
  if (NON_EARTH.some((n) => trimmed.includes(n)) && hitAny(trimmed, WEATHER_HINTS).length > 0) {
    return {
      intent: "unknown",
      slots: {},
      keywords: hitAny(trimmed, WEATHER_HINTS),
      source: "rule",
    };
  }

  // ---- 3) 天气：抽城市 / 相对时间 ----
  const weatherHits = hitAny(trimmed, WEATHER_HINTS);
  if (weatherHits.length > 0) {
    const city = findCity(trimmed);
    const slots: IntentSlots = {
      topic: "天气",
      time: findTimeHint(trimmed),
    };
    // 没有城市也允许 intent=weather（「今天天气怎么样」）；扩写阶段再补全表述
    if (city) slots.city = city;
    return {
      intent: "weather",
      slots,
      keywords: weatherHits,
      source: "rule",
    };
  }

  // ---- 4) 时间：与天气互斥（上面已 return）----
  const timeHits = hitAny(trimmed, TIME_HINTS);
  if (timeHits.length > 0) {
    return {
      intent: "time",
      slots: { time: findTimeHint(trimmed) ?? "现在" },
      keywords: timeHits,
      source: "rule",
    };
  }

  // ---- 5) 开放域：不强行 kb_search ----
  return null;
}

/**
 * CLI / 测试用：把 null 收成 unknown，方便 JSON.stringify。
 * 业务路径优先用 parseIntent 的 null，好区分「规则无把握」与「明确 unknown」。
 */
export function parseIntentOrUnknown(text: string): ParsedIntent {
  return (
    parseIntent(text) ?? {
      intent: "unknown" satisfies QueryIntent,
      slots: {},
      keywords: [],
      source: "rule",
    }
  );
}
