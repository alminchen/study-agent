/**
 * Judge 的运行时接线：真实模型调用 + 三档模式（off / shadow / enforce）。
 *
 * 三档模式在这里的行为：
 * - off（默认）：不调用模型、不产出事件，链路零变化、零延迟、零成本
 * - shadow：调用 Judge，把完整 JudgeResult 与正则 Guard 结果写进同一条 trace 事件，
 *   主回答完全不变
 * - enforce：调用 Judge，按决策表（judgePolicy.ts）决定放行还是拦截，
 *   并写一条 judge_enforced 事件说明「最终做了什么、为什么」
 *
 * 分层约定：
 * - judge.ts：判定逻辑，纯函数，模型调用靠注入（可单测）
 * - judgePolicy.ts：决策表，纯函数（可单测、可离线复用）
 * - 本文件：把前两者接到真实模型与 trace 上，不含任何判定规则
 *
 * shadow 与 enforce 都会 await 判定结果再放行主链路，保证事件落在同一条 SSE 流里；
 * 代价是首字延迟最多增加 totalTimeoutMs。默认 off 时这段开销不存在。
 */
import { getRuntimeConfig } from "../runtimeConfig.js";
import type { JudgeEnforcedTraceEvent, JudgeShadowTraceEvent } from "../react/types.js";
import {
  judgeInput,
  judgeOutput,
  type JudgeMeta,
  type JudgeModelCaller,
} from "./judge.js";
import {
  decideInputAction,
  decideOutputAction,
  SAFE_BLOCK_TEXT,
  type JudgeSurface,
  type JudgeDecisionLabel,
} from "./judgePolicy.js";
import type { RiskLevel } from "./inputGuard.js";
import type { JudgeResult } from "./judgeSchema.js";

/** Judge 相关的事件（shadow / enforced），交给上层写 trace 或 SSE。 */
export type JudgeTraceEvent = JudgeShadowTraceEvent | JudgeEnforcedTraceEvent;

/** 输入判定的调用参数。 */
export interface InputJudgeParams {
  /** 被判定的文本。 */
  text: string;
  /** 正则 Guard 的结果，用于决策表里的规则优先与分歧判定。 */
  guard: { level: RiskLevel; rules: string[] };
  /** trace 事件出口：chat 链路走 onTrace，multi/rag 链路走 SSE write。 */
  emit: (event: JudgeTraceEvent) => void;
  /** 待判定内容的身份说明；判定 RAG 资料片段时传「检索到的资料片段」。 */
  subject?: string;
  /** 判定对象，默认 input（用户输入）；检索片段传 retrieval。 */
  surface?: JudgeSurface;
}

/** 输入判定的结果，供调用方决定是否继续走模型。 */
export interface InputJudgeOutcome {
  /** allow 放行；block 拦截，调用方不应再调用模型。 */
  action: "allow" | "block";
  /** 决策分支标签。 */
  label?: JudgeDecisionLabel;
  /** 人可读原因。 */
  reason?: string;
  /** 拦截时返回给用户的安全文案。 */
  safeText?: string;
}

/**
 * 对用户输入跑一次判定，并按当前模式决定放行还是拦截。
 *
 * off 模式在这里直接返回，不会走到 await 之后的任何逻辑。
 */
export async function runInputJudge(
  params: InputJudgeParams,
): Promise<InputJudgeOutcome> {
  const config = getRuntimeConfig();
  const mode = config.judge.mode;
  if (mode === "off") return { action: "allow" };
  if (!params.text.trim()) return { action: "allow" };

  let meta: JudgeMeta | undefined;
  const judge: JudgeResult = await judgeInput(params.text, {
    callModel: createJudgeModelCaller(),
    maxInputChars: config.judge.maxInputChars,
    totalTimeoutMs: config.judge.timeouts.totalMs,
    subject: params.subject,
    onMeta: (value) => {
      meta = value;
    },
  });

  const metaPayload = {
    durationMs: meta?.durationMs ?? 0,
    truncated: meta?.truncated ?? false,
    originalChars: meta?.originalChars ?? params.text.length,
    sentChars: meta?.sentChars ?? params.text.length,
    attempts: meta?.attempts ?? 0,
  };

  // ---- shadow：只记录，不改变主回答 ----
  if (mode === "shadow") {
    params.emit({
      type: "judge_shadow",
      mode,
      surface: params.surface ?? "input",
      guard: { level: params.guard.level, rules: params.guard.rules },
      judge,
      meta: metaPayload,
    });
    return { action: "allow" };
  }

  // ---- enforce：按决策表决定放行还是拦截 ----
  const decision = decideInputAction({
    mode,
    guard: params.guard,
    judge,
    confidenceThreshold: config.judge.confidenceThreshold,
    surface: params.surface,
  });

  if (decision.label === "judge_error") {
    console.warn(`[Judge] 判定失败，已回退正则决策：${decision.reason ?? "unknown"}`);
  }

  params.emit({
    type: "judge_enforced",
    mode: "enforce",
    surface: params.surface ?? "input",
    guard: { level: params.guard.level, rules: params.guard.rules },
    judge: summarizeJudge(judge),
    action: decision.action,
    label: decision.label,
    reason: decision.reason,
    disagree: decision.disagree,
    meta: metaPayload,
  });

  if (decision.action === "block") {
    console.warn(`[Judge] 输入被拦截：${decision.reason ?? "high risk"}`);
    return {
      action: "block",
      label: decision.label,
      reason: decision.reason,
      safeText: SAFE_BLOCK_TEXT,
    };
  }

  return { action: "allow", label: decision.label, reason: decision.reason };
}

/** 输出判定的调用参数。 */
export interface OutputJudgeParams {
  /** 待判定的模型输出（完整文本）。 */
  text: string;
  /** 正则 OutputGuard 是否已判定泄露。 */
  regexLeaked: boolean;
  /** 正则命中的指纹列表，写进 trace 便于对照。 */
  matchedFingerprints?: string[];
  /** 正则命中时的替换文案；未命中可传 OutputGuard 的统一口径文案。 */
  regexSafeText?: string;
  /** trace 事件出口。 */
  emit: (event: JudgeTraceEvent) => void;
  /** 待判定内容的身份说明。 */
  subject?: string;
  /**
   * 判定前文本是否已完整缓冲。
   *
   * false = 边生成边发（真流式）。此时 enforce 一律降级为 shadow，
   * 因为文本一旦发出就收不回来，不能出现「先发出去再判定要拦」。
   */
  buffered?: boolean;
  /** 测试注入的模型调用；不传则走真实模型适配器。 */
  callModel?: JudgeModelCaller;
}

/** 输出判定的结果：只给建议，不改写主回答。 */
export interface OutputJudgeOutcome {
  /** allow 不处理；flag 建议按泄露处理。 */
  action: "allow" | "flag";
  /** 是否建议按「泄露」处理。 */
  leaked: boolean;
  /** 决策分支标签。 */
  label?: JudgeDecisionLabel;
  /** 人可读原因。 */
  reason?: string;
  /** 建议的替换文本；仅作建议，调用方自行决定是否使用。 */
  suggestedSafeText?: string;
}

/**
 * 对模型输出跑一次判定。
 *
 * 与输入侧的三点差异：
 * 1. 不产生「拦截」动作——命中只给建议（flag），主回答由调用方决定要不要换；
 * 2. 时机受限——未缓冲（真流式）时 enforce 降级为 shadow；
 * 3. 与正则 OutputGuard 互补：正则做快速指纹过滤，Judge 做语义确认。
 */
export async function runOutputJudge(
  params: OutputJudgeParams,
): Promise<OutputJudgeOutcome> {
  const config = getRuntimeConfig();
  const mode = config.judge.mode;
  if (mode === "off") {
    return { action: "allow", leaked: params.regexLeaked };
  }
  if (!params.text.trim()) {
    return { action: "allow", leaked: params.regexLeaked };
  }

  const buffered = params.buffered !== false;
  // 时机约束：文本还没缓冲完就不能 enforce，降级成只记录。
  const effectiveMode = mode === "enforce" && !buffered ? "shadow" : mode;

  let meta: JudgeMeta | undefined;
  const judge: JudgeResult = await judgeOutput(params.text, {
    callModel: params.callModel ?? createJudgeModelCaller(),
    maxInputChars: config.judge.maxInputChars,
    totalTimeoutMs: config.judge.timeouts.totalMs,
    subject: params.subject,
    onMeta: (value) => {
      meta = value;
    },
  });

  const metaPayload = {
    durationMs: meta?.durationMs ?? 0,
    truncated: meta?.truncated ?? false,
    originalChars: meta?.originalChars ?? params.text.length,
    sentChars: meta?.sentChars ?? params.text.length,
    attempts: meta?.attempts ?? 0,
  };

  const guardSummary = {
    level: params.regexLeaked ? "high" : "none",
    rules: params.matchedFingerprints ?? [],
  };

  // ---- shadow（含 enforce 降级）：只记录，不动主回答 ----
  if (effectiveMode === "shadow") {
    if (mode === "enforce" && !buffered) {
      console.warn(
        "[Judge] 输出为增量输出，无法在发出前拦截，enforce 已降级为 shadow",
      );
    }
    params.emit({
      type: "judge_shadow",
      mode: "shadow",
      surface: "output",
      guard: guardSummary,
      judge,
      meta: metaPayload,
    });
    return { action: "allow", leaked: params.regexLeaked };
  }

  // ---- enforce：按决策表给出建议，不改写回答 ----
  const decision = decideOutputAction({
    mode,
    judge,
    confidenceThreshold: config.judge.confidenceThreshold,
    regexLeaked: params.regexLeaked,
    regexSafeText: params.regexSafeText,
  });

  if (decision.label === "judge_error") {
    console.warn(
      `[Judge] 输出判定失败，已回退正则决策：${decision.reason ?? "unknown"}`,
    );
  }

  params.emit({
    type: "judge_enforced",
    mode: "enforce",
    surface: "output",
    guard: guardSummary,
    judge: summarizeJudge(judge),
    action: decision.action,
    label: decision.label,
    reason: decision.reason,
    disagree: false,
    meta: metaPayload,
  });

  return {
    action: decision.action,
    leaked: decision.leaked,
    label: decision.label,
    reason: decision.reason,
    suggestedSafeText: decision.suggestedSafeText,
  };
}

/** 把 JudgeResult 压成事件里要带的摘要字段。 */
function summarizeJudge(judge: JudgeResult): JudgeEnforcedTraceEvent["judge"] {
  if (judge.status === "error") {
    return { status: judge.status, errorKind: judge.errorKind };
  }
  return {
    status: judge.status,
    risk: judge.risk,
    confidence: judge.confidence,
    categories: judge.categories,
    shortReason: judge.shortReason,
  };
}

/**
 * 真实模型调用适配器。
 *
 * 走 OpenAI 兼容的 chat/completions；部分供应商不支持 response_format，
 * 遇到 400 时去掉该字段重试一次。
 */
export function createJudgeModelCaller(): JudgeModelCaller {
  const judge = getRuntimeConfig().judge;
  const apiKey = judge.apiKey.trim();
  if (!apiKey || process.env.MOCK_MODE === "1") {
    return createMockJudgeCaller();
  }

  const endpoint = `${judge.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return async ({ system, user, signal }) => {
    const baseBody = {
      model: judge.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 300,
    };

    let response = await postJudge(endpoint, apiKey, {
      ...baseBody,
      response_format: { type: "json_object" },
    }, signal);

    if (response.status === 400) {
      // 供应商不支持 JSON mode 时去掉 response_format 再试一次。
      response = await postJudge(endpoint, apiKey, baseBody, signal);
    }

    if (!response.ok) {
      throw new Error(`Judge 模型调用失败 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Judge 模型返回内容为空");
    }
    return content;
  };
}

/**
 * Mock 调用：只用于打通管线，不代表任何模型质量。
 */
export function createMockJudgeCaller(): JudgeModelCaller {
  return async () =>
    JSON.stringify({
      risk: "none",
      confidence: 0.9,
      categories: ["unknown"],
      shortReason: "mock 判定，未调用真实模型",
      matchedRules: [],
    });
}

/** 向 Judge 端点发一次请求。 */
async function postJudge(
  endpoint: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
}
