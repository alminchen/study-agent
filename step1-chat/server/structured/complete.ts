/**
 * 结构化输出的真实模型流适配层。
 *
 * 这里只处理 OpenAI 兼容 provider 的 SSE、超时、abort、usage 和错误分类；
 * 不解析业务 JSON，也不向浏览器写 SSE。
 */
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import type {
  StructuredChatRequest,
  StructuredErrorCode,
  StructuredTarget,
} from "./types.js";

/** 结构化请求不复用 ReAct 的非流式 complete，避免两条链路互相影响。 */
export interface StructuredCompletionTimeouts {
  /** 从发起 fetch 到收到 HTTP 响应头的上限；0 表示关闭。 */
  connectMs: number;
  /** 从响应建立到收到首个非空 content 的上限；0 表示关闭。 */
  firstChunkMs: number;
  /** 整个模型流从开始到结束的上限；0 表示关闭。 */
  totalMs: number;
}

/** 真实模型流的可观察统计；用于日志、trace 和最终诊断。 */
export interface StructuredCompletionStats {
  /** 供应商实际返回的模型名；缺失时沿用请求模型。 */
  model: string;
  /** 首个非空 content 到达时间；空 delta 不计入。 */
  firstChunkAt: number | null;
  /** 最近一个非空 content 到达时间。 */
  lastChunkAt: number | null;
  /** 实际收到的非空 content chunk 数。 */
  chunkCount: number;
  /** 所有 content chunk 的字符总数。 */
  receivedChars: number;
  /** 供应商 finish_reason；Mock 分支会单独写入 mock_completed。 */
  finishReason: string | null;
  /** 是否看到 OpenAI 兼容流的 [DONE] 哨兵。 */
  sawDone: boolean;
}

/** streamStructuredCompletion 的完整调用契约。 */
export interface StreamStructuredCompletionOptions {
  /** 已经过请求 schema 校验的结构化聊天参数。 */
  request: StructuredChatRequest;
  apiKey: string;
  baseUrl: string;
  /** 浏览器断开或用户点击停止时触发；会继续传递给 fetch。 */
  signal: AbortSignal;
  /** 是否向 provider 请求 response_format: json_object。 */
  jsonMode: boolean;
  /** 是否请求 stream_options.include_usage。 */
  includeUsage: boolean;
  timeouts: StructuredCompletionTimeouts;
  /** 只回调模型 delta.content；reasoning_content 和空 delta 不进入业务层。 */
  onChunk: (content: string) => void;
  /** 同一请求只上报一次合并后的 usage，避免 finally 与正常结束重复记账。 */
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/** 模型流失败时返回给路由层的稳定错误契约。 */
export interface StructuredCompletionFailure {
  code: StructuredErrorCode;
  message: string;
  retryable: boolean;
}

/** 模型流的三种终态；stats 在所有分支都保留，便于失败后排查。 */
export type StructuredCompletionStreamResult =
  | {
      status: "completed";
      stats: StructuredCompletionStats;
      usage: TokenUsage | null;
    }
  | {
      status: "aborted";
      stats: StructuredCompletionStats;
    }
  | {
      status: "failed";
      stats: StructuredCompletionStats;
      error: StructuredCompletionFailure;
    };

/** prompt 中的目标形状与 Zod schema 保持一一对应，减少模型输出漂移。 */
const TARGET_SCHEMA_PROMPTS: Record<StructuredTarget, string> = {
  table: [
    '目标必须是表格：{"schemaVersion":1,"block":{"kind":"table","title":"标题","columns":["列名"],"rows":[["单元格"]]}}。',
    "columns 至少 1 列、最多 8 列；rows 最多 50 行。",
    "每一行的单元格数量必须和 columns 完全一致。",
  ].join("\n"),
  code: [
    '目标必须是代码块：{"schemaVersion":1,"block":{"kind":"code","title":"标题","language":"语言","content":"代码正文"}}。',
    "language 使用简短语言名，例如 typescript、javascript、vue、bash。",
    "代码正文最多 20000 个字符。",
  ].join("\n"),
};

/** 拼接固定 system prompt；用户消息仍由 request.messages 原样追加。 */
function buildSystemPrompt(target: StructuredTarget): string {
  return [
    "你是一个严格的结构化数据生成器。",
    "只输出一个 JSON 对象，不要输出解释、前后缀或 Markdown code fence。",
    "JSON 必须严格符合下面的形状，不能增加或省略字段：",
    TARGET_SCHEMA_PROMPTS[target],
    "title 最多 80 个字符。",
    "如果用户要求的内容不适合目标类型，也要在这个 JSON 形状内给出最接近的结果。",
  ].join("\n");
}

/** OpenAI 兼容流的 delta 子集；reasoning_content 只用于识别并忽略。 */
interface ProviderDelta {
  content?: unknown;
  reasoning_content?: unknown;
}

/** 只读取第一条 choice，首版端点一次只生成一个结构化 block。 */
interface ProviderChoice {
  delta?: ProviderDelta;
  finish_reason?: unknown;
}

/** provider 可能返回的字段集合；所有值先按 unknown 校验再使用。 */
interface ProviderStreamPayload {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

/** 从一条 data: JSON 中提取出的规范化事件。 */
interface ParsedProviderEvent {
  model: string | null;
  content: string | null;
  finishReason: string | null;
  usage: TokenUsage | null;
}

/** 把 provider、超时和网络错误统一映射成路由层可消费的错误码。 */
class StructuredProviderError extends Error {
  constructor(
    readonly code: StructuredErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * 解析一条 OpenAI 兼容流事件。
 *
 * 非对象 payload 视为无内容心跳；provider 显式 error 会转成可重试错误；
 * content 为空、reasoning_content 或未知扩展字段不会进入结构化 JSON。
 */
function readProviderEvent(payload: string): ParsedProviderEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new StructuredProviderError(
      "model_stream_interrupted",
      "供应商返回了无法解析的流式事件",
      true,
    );
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      model: null,
      content: null,
      finishReason: null,
      usage: null,
    };
  }

  const data = value as ProviderStreamPayload;
  if (data.error) {
    const errorValue =
      typeof data.error === "string"
        ? data.error
        : typeof data.error === "object" &&
            data.error !== null &&
            "message" in data.error &&
            typeof data.error.message === "string"
          ? data.error.message
          : "供应商在流式响应中返回错误";
    throw new StructuredProviderError("model_request_failed", errorValue, true);
  }

  const choices = Array.isArray(data.choices)
    ? (data.choices as ProviderChoice[])
    : [];
  const choice = choices[0];
  const content =
    typeof choice?.delta?.content === "string" &&
    choice.delta.content.length > 0
      ? choice.delta.content
      : null;
  const finishReason =
    typeof choice?.finish_reason === "string" ? choice.finish_reason : null;

  return {
    model: typeof data.model === "string" ? data.model : null,
    content,
    finishReason,
    usage: parseUsageFromResponse(value),
  };
}

/**
 * 读取 OpenAI 兼容的 SSE。
 *
 * 只暴露 data 字段；event/id/retry、注释和供应商心跳都不会进入 content 提取层。
 */
async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  // reader/decoder 只负责字节到文本；SSE 帧的语义由 consumeLine 处理。
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const dataLines: string[] = [];
  const events: string[] = [];
  let buffer = "";

  // 空行表示一个 SSE 事件结束；多行 data: 按规范用换行拼接。
  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (dataLines.length > 0) {
        events.push(dataLines.join("\n"));
        dataLines.length = 0;
      }
      return;
    }
    // event/id/retry、注释心跳和其他 SSE 字段不参与业务 JSON。
    if (!line.startsWith("data:")) return;
    dataLines.push(line.slice(5).replace(/^ /, ""));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }

      while (events.length > 0) {
        yield events.shift() as string;
      }
    }

    // 流结束时 flush decoder，并补发没有以空行收尾的最后一个事件。
    buffer += decoder.decode();
    if (buffer.length > 0) consumeLine(buffer);
    consumeLine("");
    while (events.length > 0) {
      yield events.shift() as string;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 合并流式 usage。
 *
 * OpenAI 兼容流返回的是同一请求的累计值，所以逐项取最大值而不是相加；
 * 这样即使供应商重复发送 usage 也不会把 token 重复计费。
 */
function mergeStreamUsage(
  previous: TokenUsage | null,
  next: TokenUsage | null,
): TokenUsage | null {
  if (!next) return previous;
  if (!previous) return next;

  // OpenAI 兼容流的 usage 是请求累计量；多个快照取各项最大值，避免重复相加。
  return {
    promptTokens: Math.max(previous.promptTokens, next.promptTokens),
    completionTokens: Math.max(
      previous.completionTokens,
      next.completionTokens,
    ),
    totalTokens: Math.max(previous.totalTokens, next.totalTokens),
  };
}

/** 将三类超时映射到可读错误码；连接失败归为 request，首包/总时长归为 stream。 */
function timeoutFailure(
  timeout: keyof StructuredCompletionTimeouts,
): StructuredProviderError {
  const messages: Record<keyof StructuredCompletionTimeouts, string> = {
    connectMs: "连接模型服务超时",
    firstChunkMs: "等待模型首个内容 chunk 超时",
    totalMs: "结构化模型流总时长超时",
  };
  return new StructuredProviderError(
    timeout === "connectMs"
      ? "model_request_failed"
      : "model_stream_interrupted",
    messages[timeout],
    true,
  );
}

/**
 * 判断 400/422 是否明确是 JSON mode 不兼容。
 *
 * 同时要求响应正文出现 response_format 类关键词和不支持类关键词，避免把
 * 普通参数错误误判为可降级场景。
 */
function isJsonModeUnsupported(status: number, snippet: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = snippet.toLowerCase();
  return (
    /response_format|json_object|json[_ ]mode|结构化输出/.test(text) &&
    /unsupported|not supported|not support|unavailable|unknown parameter|unrecognized|invalid parameter|不支持|未知参数|无法识别/.test(
      text,
    )
  );
}

/** 把 provider HTTP 错误正文转成稳定错误码，并决定是否允许用户重试。 */
async function responseError(
  response: Response,
  jsonModeEnabled: boolean,
): Promise<StructuredProviderError> {
  let snippet = "";
  try {
    snippet = (await response.text()).slice(0, 300);
  } catch {
    // 错误响应正文不是必需信息，读取失败时保留状态码即可。
  }

  if (jsonModeEnabled && isJsonModeUnsupported(response.status, snippet)) {
    return new StructuredProviderError(
      "provider_json_mode_unsupported",
      "供应商不支持 response_format JSON mode",
      true,
    );
  }
  if (response.status === 400) {
    return new StructuredProviderError(
      "model_request_failed",
      `模型请求参数错误，请检查消息格式或 JSON mode 兼容性（400）${
        snippet ? `：${snippet}` : ""
      }`,
      false,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new StructuredProviderError(
      "model_request_failed",
      "API Key 无效或无权访问该模型",
      false,
    );
  }
  if (response.status === 429) {
    return new StructuredProviderError(
      "model_request_failed",
      "模型请求过于频繁，请稍后重试（429）",
      true,
    );
  }
  if (response.status >= 500) {
    return new StructuredProviderError(
      "model_request_failed",
      `模型服务暂时不可用（${response.status}）`,
      true,
    );
  }
  return new StructuredProviderError(
    "model_request_failed",
    `LLM 请求失败（${response.status}）${snippet ? `：${snippet}` : ""}`,
    response.status >= 500,
  );
}

/**
 * 请求真实模型的 stream:true，提取 delta.content 后逐块回调。
 *
 * 本函数不解析业务 JSON，也不直接写浏览器 SSE；这两件事仍由 route 和
 * StructuredStreamAccumulator 负责，从而保持 Mock / 真实模型契约一致。
 */
export async function streamStructuredCompletion(
  options: StreamStructuredCompletionOptions,
): Promise<StructuredCompletionStreamResult> {
  // 本地统计只描述真实模型流，不在这里解析业务 JSON。
  const startedAt = Date.now();
  let responseModel = options.request.model;
  let firstChunkAt: number | null = null;
  let lastChunkAt: number | null = null;
  let chunkCount = 0;
  let receivedChars = 0;
  let finishReason: string | null = null;
  let sawDone = false;
  let usage: TokenUsage | null = null;
  let responseReceived = false;
  let timeoutError: StructuredProviderError | null = null;
  let usageReported = false;

  // 每次返回终态时重新生成快照，避免调用方持有可变的内部计数对象。
  const stats = (): StructuredCompletionStats => ({
    model: responseModel,
    firstChunkAt,
    lastChunkAt,
    chunkCount,
    receivedChars,
    finishReason,
    sawDone,
  });

  // 外层 signal 代表客户端停止；内部 controller 还承载 connect/firstChunk/total 超时。
  const controller = new AbortController();
  const abortFromClient = () => controller.abort();
  if (options.signal.aborted) {
    return { status: "aborted", stats: stats() };
  }
  options.signal.addEventListener("abort", abortFromClient, { once: true });

  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;

  // 三个计时器共用一个清理函数，确保成功、失败和 abort 都不会遗留定时器。
  const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer);
  };
  // 先保存具体超时类型再 abort；catch 分支据此返回精确错误。
  const failOnTimeout = (name: keyof StructuredCompletionTimeouts) => {
    timeoutError = timeoutFailure(name);
    controller.abort();
  };
  // usage 只上报一次；正常路径先报，finally 作为兜底。
  const reportUsage = () => {
    if (!usage || usageReported) return;
    usageReported = true;
    options.onUsage?.(usage, responseModel);
  };

  try {
    // connect 和 total 在 fetch 前启动；firstChunk 要等响应头成功后再启动。
    if (options.timeouts.connectMs > 0) {
      connectTimer = setTimeout(
        () => failOnTimeout("connectMs"),
        options.timeouts.connectMs,
      );
    }
    if (options.timeouts.totalMs > 0) {
      totalTimer = setTimeout(
        () => failOnTimeout("totalMs"),
        options.timeouts.totalMs,
      );
    }

    // 业务请求沿用原 messages；system 由服务端固定注入，避免前端改写协议约束。
    const body: Record<string, unknown> = {
      model: options.request.model,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(options.request.target),
        },
        ...options.request.messages,
      ],
      stream: true,
    };
    // JSON mode 与 usage 都是可选能力，供应商不支持时可通过配置或降级关闭。
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (options.includeUsage) {
      body.stream_options = { include_usage: true };
    }

    // 使用 OpenAI 兼容 chat/completions；baseUrl 去掉尾部斜杠后再拼路径。
    const response = await fetch(
      `${options.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    responseReceived = true;
    clearTimer(connectTimer);
    connectTimer = null;

    // HTTP 错误必须在读取 body 前分类，否则会丢失 status 和响应片段。
    if (!response.ok) {
      throw await responseError(response, options.jsonMode);
    }
    if (!response.body) {
      throw new StructuredProviderError(
        "model_stream_interrupted",
        "模型响应没有可读取的流式正文",
        true,
      );
    }

    // 收到响应头不代表模型开始输出；首内容计时从这一刻开始。
    if (options.timeouts.firstChunkMs > 0) {
      firstChunkTimer = setTimeout(
        () => failOnTimeout("firstChunkMs"),
        options.timeouts.firstChunkMs,
      );
    }

    // 逐个 SSE data 事件读取；[DONE] 只表示 provider 流结束，不表示 schema 已通过。
    for await (const payload of readSseData(response.body)) {
      if (options.signal.aborted || controller.signal.aborted) break;
      if (payload.trim() === "[DONE]") {
        sawDone = true;
        break;
      }

      // 先更新模型名/finish/usage，再决定是否把 content 交给累积器。
      const event = readProviderEvent(payload);
      if (event.model) responseModel = event.model;
      if (event.finishReason) finishReason = event.finishReason;
      usage = mergeStreamUsage(usage, event.usage);

      // reasoning_content、空 delta 和非标准供应商字段不进入业务 JSON。
      if (!event.content) continue;

      // 第一个真实 content 到达后关闭首包计时，后续 chunk 不再重置它。
      clearTimer(firstChunkTimer);
      firstChunkTimer = null;
      const receivedAt = Date.now();
      firstChunkAt ??= receivedAt;
      lastChunkAt = receivedAt;
      chunkCount += 1;
      receivedChars += event.content.length;
      options.onChunk(event.content);
    }

    // 客户端中止优先于其他失败；保留已收统计供上层记录。
    if (options.signal.aborted) {
      return { status: "aborted", stats: stats() };
    }
    if (timeoutError) throw timeoutError;
    // 只有看到 [DONE]、至少一个 content 和 finish_reason，才算 provider 正常结束。
    if (chunkCount === 0) {
      throw new StructuredProviderError(
        "model_stream_interrupted",
        "模型流没有返回可解析的 content",
        true,
      );
    }
    if (!sawDone) {
      throw new StructuredProviderError(
        "model_stream_interrupted",
        "模型流在 [DONE] 前中断",
        true,
      );
    }
    if (!finishReason) {
      throw new StructuredProviderError(
        "model_stream_interrupted",
        "模型流没有返回 finish_reason",
        true,
      );
    }

    // 正常完成前上报 usage；finally 的第二次调用会被 usageReported 拦截。
    reportUsage();
    return {
      status: "completed",
      stats: stats(),
      usage,
    };
  } catch (error) {
    // 主动停止不算业务失败，也不触发重试。
    if (options.signal.aborted) {
      return { status: "aborted", stats: stats() };
    }
    if (timeoutError) {
      return { status: "failed", stats: stats(), error: timeoutError };
    }
    if (error instanceof StructuredProviderError) {
      return { status: "failed", stats: stats(), error };
    }

    // 未分类异常根据是否收到响应头区分连接失败与读取中断。
    const message = error instanceof Error ? error.message : "未知模型流错误";
    return {
      status: "failed",
      stats: stats(),
      error: {
        code: responseReceived
          ? "model_stream_interrupted"
          : "model_request_failed",
        message: responseReceived
          ? `模型流读取中断：${message}`
          : `无法连接模型服务：${message}`,
        retryable: true,
      },
    };
  } finally {
    // 所有终态都清理计时器、解绑 listener，并补报可能只在 finally 才出现的 usage。
    reportUsage();
    clearTimer(connectTimer);
    clearTimer(firstChunkTimer);
    clearTimer(totalTimer);
    options.signal.removeEventListener("abort", abortFromClient);
    console.debug("[structured-complete] finished", {
      durationMs: Date.now() - startedAt,
      ...stats(),
      hasUsage: Boolean(usage),
    });
  }
}
