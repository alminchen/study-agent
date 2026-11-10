/**
 * 读运行时配置。
 * mockMode = 强制 MOCK_MODE=1，或根本没有 LLM_API_KEY → 走假流式，不产生真实 usage。
 */
import {
  DEFAULT_BUDGET_RATIO,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "./context/tokenBudget.js";

/** 读取可关闭的超时配置；0 表示关闭，非法或负数回退到默认值。 */
function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 读取 0~1 之间的小数比例；非法值回退到默认值。 */
function readRatio(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) return fallback;
  return value;
}

/** 读取 0~1（含两端）的小数；置信度阈值需要允许取 0，所以不复用 readRatio。 */
function readUnitInterval(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * Judge 的运行模式。
 *
 * mode 是唯一开关源，不再并列第二个 enabled 布尔——两个开关迟早会打架。
 */
export type JudgeMode = "off" | "shadow" | "enforce";

const JUDGE_MODES: readonly string[] = ["off", "shadow", "enforce"];

/** 非法模式只警告一次，避免每个请求刷一次日志。 */
let warnedInvalidJudgeMode = false;

/**
 * 读取 Judge 模式；非法值回落到 off 而不是抛错。
 *
 * 判定链路属于安全增强能力，配错了最多是不生效，不该让主链路起不来。
 */
function readJudgeMode(): JudgeMode {
  const raw = process.env.JUDGE_MODE?.trim().toLowerCase();
  if (!raw) return "off";
  if (JUDGE_MODES.includes(raw)) return raw as JudgeMode;
  if (!warnedInvalidJudgeMode) {
    warnedInvalidJudgeMode = true;
    console.warn(
      `[runtime-config] JUDGE_MODE=${raw} 不是合法取值，已回落到 off（可选值：off|shadow|enforce）`,
    );
  }
  return "off";
}

/**
 * Reflection 的运行模式。
 *
 * 与 Judge 同形但语义不同：Judge 管「输出能不能放出去」，
 * Reflection 管「答案要不要回头改」，两者互不替代。
 *
 * off 是默认值：自我评估的收益还没被 Evals 证明，
 * 就不该默认改写用户看到的答案。
 */
export type ReflectionMode = "off" | "shadow" | "enforce";

const REFLECTION_MODES: readonly string[] = ["off", "shadow", "enforce"];

/** 非法模式只警告一次，避免每个请求刷一次日志。 */
let warnedInvalidReflectionMode = false;

/**
 * 读取 Reflection 模式；非法值回落到 off。
 *
 * 和 Judge 同样的理由：Reflection 配错的后果是「没生效」，
 * 不该让整个聊天端点起不来。
 */
function readReflectionMode(): ReflectionMode {
  const raw = process.env.REFLECTION_MODE?.trim().toLowerCase();
  if (!raw) return "off";
  if (REFLECTION_MODES.includes(raw)) return raw as ReflectionMode;
  if (!warnedInvalidReflectionMode) {
    warnedInvalidReflectionMode = true;
    console.warn(
      `[runtime-config] REFLECTION_MODE=${raw} 不是合法取值，已回落到 off（可选值：off|shadow|enforce）`,
    );
  }
  return "off";
}

export function getRuntimeConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const forceMock = process.env.MOCK_MODE === "1";
  const mockMode = forceMock || !apiKey;
  const model = process.env.LLM_MODEL ?? "deepseek-chat";
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
  return {
    apiKey,
    forceMock,
    mockMode,
    model,
    baseUrl,
    // 长上下文管理：注入预算 = 窗口 × 比例。
    // 窗口取模型官方上限的保守值，比例宁小勿大（剩下的留给输出和模型自身余量）。
    context: {
      windowTokens: readNonNegativeInt(
        "LLM_CONTEXT_WINDOW_TOKENS",
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      ),
      budgetRatio: readRatio(
        "LLM_CONTEXT_BUDGET_RATIO",
        DEFAULT_BUDGET_RATIO,
      ),
    },
    // 结构化端点单独持有能力开关和超时，避免影响普通聊天/RAG 的请求行为。
    structuredRequest: {
      // 默认请求 provider 的 JSON mode；设置为 "0" 可强制走纯 prompt 约束。
      jsonMode: process.env.LLM_STRUCTURED_JSON_MODE !== "0",
      // 默认请求流末尾 usage；部分兼容供应商不支持 stream_options 时可关闭。
      includeUsage: process.env.LLM_STRUCTURED_INCLUDE_USAGE !== "0",
      timeouts: {
        // 建立连接、等待首内容 chunk、整次结构化流分别限时。
        connectMs: readNonNegativeInt(
          "LLM_STRUCTURED_CONNECT_TIMEOUT_MS",
          15_000,
        ),
        firstChunkMs: readNonNegativeInt(
          "LLM_STRUCTURED_FIRST_CHUNK_TIMEOUT_MS",
          30_000,
        ),
        totalMs: readNonNegativeInt(
          "LLM_STRUCTURED_TOTAL_TIMEOUT_MS",
          180_000,
        ),
      },
    },
    /**
     * LLM-as-Judge 的独立配置。
     *
     * 刻意与主对话模型解耦：主模型繁忙或降级时，Guard 不应该跟着变慢或失效。
     * Judge 的超时也远短于主链路，超时即按 error 处理并回退正则决策。
     */
    judge: {
      /** 唯一开关：off 不调用、shadow 只记录、enforce 才参与拦截决策。 */
      mode: readJudgeMode(),
      /** 未单独配置时沿用主模型配置，保证开箱可用。 */
      model: process.env.JUDGE_MODEL?.trim() || model,
      baseUrl: process.env.JUDGE_BASE_URL?.trim() || baseUrl,
      /** Judge 可以用独立 Key；未配置时复用主 Key。 */
      apiKey: process.env.JUDGE_API_KEY?.trim() || apiKey,
      timeouts: {
        /** 建立连接的上限。 */
        connectMs: readNonNegativeInt("JUDGE_CONNECT_TIMEOUT_MS", 2_000),
        /** 等待首个内容 chunk 的上限。 */
        firstChunkMs: readNonNegativeInt(
          "JUDGE_FIRST_CHUNK_TIMEOUT_MS",
          5_000,
        ),
        /** 整次判定的上限；超时后不再重试。 */
        totalMs: readNonNegativeInt("JUDGE_TOTAL_TIMEOUT_MS", 8_000),
      },
      /** 送进 Judge 的文本上限；0 表示不截断。 */
      maxInputChars: readNonNegativeInt("JUDGE_MAX_INPUT_CHARS", 4_000),
      /** 低于该置信度的高/中风险判定一律降级为放行加打标。 */
      confidenceThreshold: readUnitInterval(
        "JUDGE_CONFIDENCE_THRESHOLD",
        0.6,
      ),
    },
    /**
     * Reflection 的独立配置。
     *
     * 只有模式开关，没有独立模型/Key：自我评估本来就该由生成答案的
     * 同一个模型来做，换模型评就变成了「另一个模型的意见」，不再是自我评估。
     */
    reflection: {
      /** off 直接返回初版答案；shadow 只报告；enforce 才允许改写正文。 */
      mode: readReflectionMode(),
    },
  };
}
