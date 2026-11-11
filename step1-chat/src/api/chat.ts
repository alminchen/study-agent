import type {
  ChatRole,
  ContextCompactionEvent,
  ContextSummary,
  Plan,
  PlanErrorCode,
  PlanEvent,
  PlanMode,
  PlanReplannedEvent,
  PlanRouteEvent,
  ReflectionIssue,
  ReflectionScores,
  StructuredClientError,
  StructuredDoneEvent,
  StructuredSnapshotEvent,
  StructuredTarget,
  ToolTraceStep,
  UsageSnapshot,
  VisionErrorCode,
} from "../types";
import { normalizeContextSummary } from "../types";
import { parseMemoryTraceStep } from "./memoryTrace";

/**
 * wire 协议里的图片附件形状（步骤 7）。
 *
 * 字段与服务端 server/react/types.ts 的 ImageAttachment 同名同义：
 * data 是 base64 裸串（不含 data: 前缀），previewUrl 等端内字段不跨线。
 */
export interface ApiImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  data: string;
}

export interface StreamChatParams {
  messages: Array<{
    role: ChatRole;
    content: string;
    /** 当前轮携带的完整图片数据；只有最后一条 user 消息会带（决策二）。 */
    attachments?: ApiImageAttachment[];
  }>;
  model: string;
  signal: AbortSignal;
  /** 打开后服务端强制检索并注入本轮 system（语义 C）；不再把 searchDocs 交给模型。 */
  searchDocs?: boolean;
  /**
   * 是否走多 Agent。
   * true → POST /api/chat/multi；false → POST /api/chat。
   * 与 searchDocs 无关，由调用方显式传入。
   */
  multiAgent?: boolean;
  /**
   * 前端持久化的上下文摘要，请求时带回服务端。
   * 服务端会校验；非法摘要按「没有摘要」处理，不会让请求失败。
   */
  contextSummary?: ContextSummary | null;
  /**
   * 匿名用户 id（anon_xxx）：跨会话记忆的归属标识。
   * 只在本地生成、只存在 localStorage，服务端不采集任何真实身份。
   */
  userId?: string;
  /**
   * 是否允许使用长期记忆。
   * 关掉时**不带 userId**：服务端要求 allowMemory===true 且 userId 合法才注入，
   * 两者缺一不可——「关掉」必须是真的零注入，而不是服务端再判断一次。
   */
  allowMemory?: boolean;
  onDelta: (delta: string) => void;
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  /** 上下文压缩事件；只在服务端真的丢掉内容时才触发。 */
  onContextCompacted?: (event: ContextCompactionEvent) => void;
  onError: (error: string) => void;
}

export interface HealthInfo {
  mode: "mock" | "api";
  model: string;
}

export interface StreamStructuredParams {
  /** 已转换为 API 消息形状的历史，不包含 partial snapshot。 */
  messages: Array<{ role: ChatRole; content: string }>;
  model: string;
  /** table/code 决定服务端 system prompt 和最终 block 形状。 */
  target: StructuredTarget;
  /**
   * 匿名用户 id（anon_xxx）：跨会话记忆的归属标识。
   * 只在本地生成、只存 localStorage，服务端不采集任何真实身份。
   */
  userId?: string;
  /**
   * 是否允许使用长期记忆。
   * 关掉时**不带 userId**：服务端要求 allowMemory===true 且 userId 合法才注入，
   * 两者缺一不可——「关掉」必须是真的零注入，而不是服务端再判断一次。
   */
  allowMemory?: boolean;
  /** stop() 会 abort 此 signal，服务端 close 后终止上游模型请求。 */
  signal: AbortSignal;
  /** 只在服务端证明快照稳定且 revision 增长时回调。 */
  onSnapshot: (event: StructuredSnapshotEvent) => void;
  /** 只有最终 Zod 校验通过后才会回调。 */
  onDone: (event: StructuredDoneEvent) => void;
  /** 记忆过程事件（注入 / 抽取 / 失败）走这里，进工具过程面板。 */
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  /** 网络、协议、解析和 schema 失败都收敛到这个回调。 */
  onError: (error: StructuredClientError) => void;
}

export interface ConfirmChatParams {
  confirmId: string;
  toolCallId: string;
  action: "allow" | "deny";
}

export interface StreamPlanParams {
  messages: Array<{ role: ChatRole; content: string }>;
  model: string;
  signal: AbortSignal;
  /** auto 按规则判断；react 强制走 ReAct；plan 强制进 Planner。 */
  mode?: PlanMode;
  searchDocs?: boolean;
  /**
   * 匿名用户 id（anon_xxx）：跨会话记忆的归属标识。
   * 只在本地生成、只存 localStorage，服务端不采集任何真实身份。
   */
  userId?: string;
  /**
   * 是否允许使用长期记忆。
   * 关掉时**不带 userId**：服务端要求 allowMemory===true 且 userId 合法才注入，
   * 两者缺一不可——「关掉」必须是真的零注入，而不是服务端再判断一次。
   */
  allowMemory?: boolean;
  /** 计划事件（plan_*）统一走这里；未知事件被忽略，不会让流中断。 */
  onPlanEvent: (event: PlanEvent) => void;
  onDelta: (delta: string) => void;
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  onError: (error: string) => void;
}

export interface StreamReflectionParams {
  /** 单轮问题；服务端据此生成初版答案并复盘。 */
  question: string;
  model: string;
  signal: AbortSignal;
  /** 会话标识，服务端只用来串联日志。 */
  sessionId?: string;
  /** 只能把服务端模式往下调（enforce → shadow）；不传表示沿用服务端配置。 */
  mode?: "shadow" | "enforce";
  searchDocs?: boolean;
  /** 正文由服务端在复盘结束后一次性给出，前端只负责拼接。 */
  onDelta: (delta: string) => void;
  /** 工具轨迹 + 反思事件（评分 / 重写 / 跳过）统一走这里。 */
  onTrace?: (step: ToolTraceStep) => void;
  onUsage?: (usage: UsageSnapshot) => void;
  onError: (error: string) => void;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 把服务端给的分数对象收敛成四维分数；缺项补 0，不让面板因脏数据崩掉。 */
function parseReflectionScores(raw: unknown): ReflectionScores {
  const source = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): number =>
    typeof source[key] === "number" ? source[key] : 0;
  return {
    relevance: read("relevance"),
    completeness: read("completeness"),
    groundedness: read("groundedness"),
    clarity: read("clarity"),
  };
}

/** 解析问题列表；只保留维度与描述两字段。 */
function parseReflectionIssues(raw: unknown): ReflectionIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const issue = item as Record<string, unknown>;
    const dimension = asString(issue.dimension);
    const detail = asString(issue.detail);
    if (!dimension || !detail) return [];
    return [{ dimension, detail }];
  });
}

/**
 * 解析 context_compacted 事件。
 *
 * 这个事件**不带 delta 字段**，所以永远不会污染回答正文气泡。
 * 字段缺失或类型不对就返回 null，由调用方忽略——单条事件解析失败不能打断整条流。
 */
function parseContextCompactionEvent(
  raw: Record<string, unknown>,
): ContextCompactionEvent | null {
  if (raw.type !== "context_compacted") return null;
  const { compactedRounds, originalTokens, compactedTokens, summaryTokens } = raw;
  if (
    typeof compactedRounds !== "number" ||
    typeof originalTokens !== "number" ||
    typeof compactedTokens !== "number" ||
    typeof summaryTokens !== "number"
  ) {
    return null;
  }
  return {
    type: "context_compacted",
    compactedRounds,
    originalTokens,
    compactedTokens,
    summaryTokens,
    degraded: raw.degraded === true,
    // 摘要也要过一遍校验：非法摘要当没有，UI 仍然照常显示压缩提示。
    summary: normalizeContextSummary(raw.summary),
  };
}

/**
 * 解析计划事件。
 * 字段缺失或类型不对就返回 null，由调用方忽略，绝不抛错打断整条流。
 */
function parsePlanEvent(raw: Record<string, unknown>): PlanEvent | null {
  const type = asString(raw.type);
  const planId = asString(raw.planId);
  const revision = typeof raw.revision === "number" ? raw.revision : null;

  if (type === "plan_route") {
    const mode = asString(raw.mode);
    const reasonCode = asString(raw.reasonCode);
    if ((mode !== "react" && mode !== "plan") || !reasonCode) return null;
    const event: PlanRouteEvent = {
      type,
      mode,
      reasonCode: reasonCode as PlanRouteEvent["reasonCode"],
      signals: Array.isArray(raw.signals)
        ? raw.signals.filter((item): item is string => typeof item === "string")
        : [],
    };
    return event;
  }

  if (type === "plan_created" && planId && revision !== null && raw.plan) {
    return {
      type,
      planId,
      revision,
      plan: raw.plan as Plan,
    } as PlanEvent;
  }

  if (type === "plan_step_started" && planId && revision !== null) {
    const stepId = asString(raw.stepId);
    if (!stepId) return null;
    return {
      type,
      planId,
      revision,
      stepId,
      index: typeof raw.index === "number" ? raw.index : 0,
      total: typeof raw.total === "number" ? raw.total : 0,
    } as PlanEvent;
  }

  if (type === "plan_step_done" && planId && revision !== null) {
    const stepId = asString(raw.stepId);
    if (!stepId) return null;
    return {
      type,
      planId,
      revision,
      stepId,
      summary: asString(raw.summary) ?? "",
      toolsCalled: Array.isArray(raw.toolsCalled)
        ? raw.toolsCalled.filter((item): item is string => typeof item === "string")
        : [],
    } as PlanEvent;
  }

  if (type === "plan_step_failed" && planId && revision !== null) {
    const stepId = asString(raw.stepId);
    // stepId 为空是计划级失败（如 Re-plan 未被采纳），要透传给前端单独展示。
    return {
      type,
      planId,
      revision,
      stepId,
      code: (asString(raw.code) ?? "tool_failed") as PlanErrorCode,
      message: asString(raw.message) ?? "",
      retryable: raw.retryable === true,
    } as PlanEvent;
  }

  if (type === "plan_replanned" && planId && revision !== null) {
    const previousRevision =
      typeof raw.previousRevision === "number" ? raw.previousRevision : 0;
    if (!raw.plan) return null;
    const event: PlanReplannedEvent = {
      type,
      planId,
      previousRevision,
      revision,
      reason: asString(raw.reason) ?? "",
      plan: raw.plan as Plan,
    };
    return event;
  }

  if (type === "plan_finished") {
    const status = asString(raw.status);
    if (status !== "completed" && status !== "failed" && status !== "aborted") {
      return null;
    }
    return {
      type,
      status,
      completedSteps:
        typeof raw.completedSteps === "number" ? raw.completedSteps : 0,
      totalSteps: typeof raw.totalSteps === "number" ? raw.totalSteps : 0,
    } as PlanEvent;
  }

  if (type === "plan_fallback") {
    const reasonCode = asString(raw.reasonCode);
    if (!reasonCode) return null;
    return {
      type,
      reasonCode: reasonCode as PlanErrorCode,
      message: asString(raw.message) ?? "",
    } as PlanEvent;
  }

  return null;
}

/**
 * 计划模式流式聊天：POST /api/chat/plan（SSE）。
 *
 * 与 streamChat 的差别：
 * - 端点固定 /api/chat/plan，请求体多一个 mode。
 * - 计划事件走 onPlanEvent；工具事件形状不变，仍走 onTrace。
 * - 未知事件一律忽略，不能让整个流崩溃。
 */
export async function streamPlan({
  messages,
  model,
  signal,
  mode = "auto",
  searchDocs,
  userId,
  allowMemory = false,
  onPlanEvent,
  onDelta,
  onTrace,
  onUsage,
  onError,
}: StreamPlanParams): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/chat/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        model,
        mode,
        searchDocs: Boolean(searchDocs),
        // 记忆：关掉时连 userId 一起不带，服务端直接零注入。
        ...(allowMemory && userId ? { userId, allowMemory: true } : { allowMemory: false }),
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "网络请求失败");
    return false;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    onError(body?.error ?? `服务异常：${response.status}`);
    return false;
  }
  if (!response.body) {
    onError("当前浏览器不支持流式响应");
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return true;

          let event: Record<string, unknown>;
          try {
            const parsed = JSON.parse(payload) as unknown;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              continue;
            }
            event = parsed as Record<string, unknown>;
          } catch {
            // 单个损坏事件不应中断整条流。
            continue;
          }

          if (typeof event.error === "string") {
            onError(event.error);
            return true;
          }

          if (event.type === "usage" && typeof event.totalTokens === "number") {
            onUsage?.({
              endpoint: event.endpoint as UsageSnapshot["endpoint"],
              model: asString(event.model) ?? model,
              promptTokens:
                typeof event.promptTokens === "number" ? event.promptTokens : 0,
              completionTokens:
                typeof event.completionTokens === "number"
                  ? event.completionTokens
                  : 0,
              totalTokens: event.totalTokens,
              llmCalls: typeof event.llmCalls === "number" ? event.llmCalls : 1,
              estimatedCostUsd:
                typeof event.estimatedCostUsd === "number"
                  ? event.estimatedCostUsd
                  : 0,
              imageCount:
                typeof event.imageCount === "number" ? event.imageCount : 0,
              imageBytes:
                typeof event.imageBytes === "number" ? event.imageBytes : 0,
              estimatedImageTokens:
                typeof event.estimatedImageTokens === "number"
                  ? event.estimatedImageTokens
                  : 0,
            });
            continue;
          }

          if (event.type === "tool_call" && asString(event.name)) {
            onTrace?.({
              kind: "tool_call",
              name: event.name as string,
              arguments: event.arguments,
            });
            continue;
          }
          if (event.type === "tool_result" && asString(event.name)) {
            onTrace?.({
              kind: "tool_result",
              name: event.name as string,
              result: event.result,
            });
            continue;
          }
          if (event.type === "pending_confirm" && asString(event.name)) {
            onTrace?.({
              kind: "pending_confirm",
              confirmId: asString(event.confirmId) ?? "",
              toolCallId: asString(event.toolCallId) ?? "",
              name: event.name as string,
              arguments: event.arguments,
              status: "pending",
            });
            continue;
          }
          if (
            event.type === "confirm_resolved" &&
            (event.action === "allow" || event.action === "deny")
          ) {
            onTrace?.({
              kind: "confirm_resolved",
              toolCallId: asString(event.toolCallId) ?? "",
              name: asString(event.name) ?? "",
              action: event.action,
            });
            continue;
          }
          if (event.type === "injection_detected") {
            onTrace?.({
              kind: "injection_detected",
              level: asString(event.level) ?? undefined,
              rules: Array.isArray(event.rules)
                ? event.rules.filter((item): item is string => typeof item === "string")
                : [],
            });
            continue;
          }

          if (event.type === "judge_shadow") {
            const guard = (event.guard ?? {}) as Record<string, unknown>;
            const judge = (event.judge ?? {}) as Record<string, unknown>;
            const meta = (event.meta ?? {}) as Record<string, unknown>;
            onTrace?.({
              kind: "judge_shadow",
              mode: asString(event.mode) ?? "shadow",
              surface: asString(event.surface) ?? "input",
              guard: {
                level: asString(guard.level) ?? "none",
                rules: Array.isArray(guard.rules)
                  ? guard.rules.filter((item): item is string => typeof item === "string")
                  : [],
              },
              judge: {
                status: asString(judge.status) ?? "error",
                risk: asString(judge.risk) ?? undefined,
                confidence:
                  typeof judge.confidence === "number" ? judge.confidence : undefined,
                categories: Array.isArray(judge.categories)
                  ? judge.categories.filter((item): item is string => typeof item === "string")
                  : [],
                shortReason: asString(judge.shortReason) ?? undefined,
                errorKind: asString(judge.errorKind) ?? undefined,
              },
              meta: {
                durationMs:
                  typeof meta.durationMs === "number" ? meta.durationMs : undefined,
                truncated: meta.truncated === true,
              },
            });
            continue;
          }
          if (event.type === "judge_enforced") {
            const guard = (event.guard ?? {}) as Record<string, unknown>;
            const judge = (event.judge ?? {}) as Record<string, unknown>;
            const meta = (event.meta ?? {}) as Record<string, unknown>;
            onTrace?.({
              kind: "judge_enforced",
              mode: asString(event.mode) ?? "enforce",
              surface: asString(event.surface) ?? "input",
              guard: {
                level: asString(guard.level) ?? "none",
                rules: Array.isArray(guard.rules)
                  ? guard.rules.filter((item): item is string => typeof item === "string")
                  : [],
              },
              judge: {
                status: asString(judge.status) ?? "error",
                risk: asString(judge.risk) ?? undefined,
                confidence:
                  typeof judge.confidence === "number" ? judge.confidence : undefined,
                categories: Array.isArray(judge.categories)
                  ? judge.categories.filter((item): item is string => typeof item === "string")
                  : [],
                shortReason: asString(judge.shortReason) ?? undefined,
                errorKind: asString(judge.errorKind) ?? undefined,
              },
              action: asString(event.action) ?? "allow",
              label: asString(event.label) ?? undefined,
              reason: asString(event.reason) ?? undefined,
              disagree: event.disagree === true,
              meta: {
                durationMs:
                  typeof meta.durationMs === "number" ? meta.durationMs : undefined,
                truncated: meta.truncated === true,
              },
            });
            continue;
          }
          if (event.type === "output_leak_blocked") {
            onTrace?.({
              kind: "output_leak_blocked",
              matchedFingerprints: Array.isArray(event.matchedFingerprints)
                ? event.matchedFingerprints.filter(
                    (item): item is string => typeof item === "string",
                  )
                : [],
            });
            continue;
          }

          if (typeof event.delta === "string" && event.delta) {
            onDelta(event.delta);
            continue;
          }

          // 记忆事件（memory_injected / memory_extracted / memory_failed）：
          // 与普通对话链路共用同一份解析，四条链路口径一致。
          const memoryStep = parseMemoryTraceStep(event);
          if (memoryStep) {
            onTrace?.(memoryStep);
            continue;
          }

          // 计划事件交给状态层；无法识别的事件直接忽略。
          const planEvent = parsePlanEvent(event);
          if (planEvent) onPlanEvent(planEvent);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "流式读取失败");
    return false;
  }
  return true;
}

/**
 * Reflection 链路：POST /api/chat/reflection（SSE）。
 *
 * 与 streamChat / streamPlan 的差别：
 * - 请求体是「一个问题」而不是 messages 数组，服务端自己生成初版答案。
 * - 正文不是流式的：服务端在「初评 → 重写 → 重评」全部结束后才推一次 delta，
 *   所以这里不做任何增量拼接假设。
 * - 除工具轨迹外还会收到 reflection_scored / reflection_revised / reflection_skipped，
 *   它们只进调试面板，不会污染正文。
 */
export async function streamReflection({
  question,
  model,
  signal,
  sessionId,
  mode,
  searchDocs,
  onDelta,
  onTrace,
  onUsage,
  onError,
}: StreamReflectionParams): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch("/api/chat/reflection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        model,
        sessionId: sessionId ?? null,
        mode: mode ?? null,
        searchDocs: Boolean(searchDocs),
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "网络请求失败");
    return false;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    onError(body?.error ?? `服务异常：${response.status}`);
    return false;
  }
  if (!response.body) {
    onError("当前浏览器不支持流式响应");
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return true;

          let event: Record<string, unknown>;
          try {
            const parsed = JSON.parse(payload) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              continue;
            }
            event = parsed as Record<string, unknown>;
          } catch {
            // 单个损坏事件不应中断整条流。
            continue;
          }

          if (typeof event.error === "string") {
            onError(event.error);
            return true;
          }

          if (event.type === "usage" && typeof event.totalTokens === "number") {
            onUsage?.({
              endpoint: event.endpoint as UsageSnapshot["endpoint"],
              model: asString(event.model) ?? model,
              promptTokens:
                typeof event.promptTokens === "number" ? event.promptTokens : 0,
              completionTokens:
                typeof event.completionTokens === "number"
                  ? event.completionTokens
                  : 0,
              totalTokens: event.totalTokens,
              llmCalls: typeof event.llmCalls === "number" ? event.llmCalls : 1,
              estimatedCostUsd:
                typeof event.estimatedCostUsd === "number"
                  ? event.estimatedCostUsd
                  : 0,
              imageCount:
                typeof event.imageCount === "number" ? event.imageCount : 0,
              imageBytes:
                typeof event.imageBytes === "number" ? event.imageBytes : 0,
              estimatedImageTokens:
                typeof event.estimatedImageTokens === "number"
                  ? event.estimatedImageTokens
                  : 0,
            });
            continue;
          }

          // ---- 工具轨迹：与普通链路同构，原样转成 trace 步骤 ----
          if (event.type === "tool_call" && asString(event.name)) {
            onTrace?.({
              kind: "tool_call",
              name: event.name as string,
              arguments: event.arguments,
            });
            continue;
          }
          if (event.type === "tool_result" && asString(event.name)) {
            onTrace?.({
              kind: "tool_result",
              name: event.name as string,
              result: event.result,
            });
            continue;
          }
          if (event.type === "pending_confirm" && asString(event.name)) {
            onTrace?.({
              kind: "pending_confirm",
              confirmId: asString(event.confirmId) ?? "",
              toolCallId: asString(event.toolCallId) ?? "",
              name: event.name as string,
              arguments: event.arguments,
              status: "pending",
            });
            continue;
          }
          if (
            event.type === "confirm_resolved" &&
            (event.action === "allow" || event.action === "deny")
          ) {
            onTrace?.({
              kind: "confirm_resolved",
              toolCallId: asString(event.toolCallId) ?? "",
              name: asString(event.name) ?? "",
              action: event.action,
            });
            continue;
          }
          if (event.type === "injection_detected") {
            onTrace?.({
              kind: "injection_detected",
              level: asString(event.level) ?? undefined,
              rules: Array.isArray(event.rules)
                ? event.rules.filter((item): item is string => typeof item === "string")
                : [],
            });
            continue;
          }

          // ---- 反思事件：只进调试面板，绝不进正文 ----
          if (event.type === "reflection_scored") {
            const meta = (event.meta ?? {}) as Record<string, unknown>;
            onTrace?.({
              kind: "reflection_scored",
              stage: event.stage === "revised" ? "revised" : "initial",
              scores: parseReflectionScores(event.scores),
              average: typeof event.average === "number" ? event.average : 0,
              issues: parseReflectionIssues(event.issues),
              shouldRewrite: event.shouldRewrite === true,
              reason: asString(event.reason) ?? "",
              meta: {
                durationMs:
                  typeof meta.durationMs === "number" ? meta.durationMs : undefined,
                attempts:
                  typeof meta.attempts === "number" ? meta.attempts : undefined,
                truncated: meta.truncated === true,
              },
            });
            continue;
          }
          if (event.type === "reflection_revised") {
            // revisedText 是修订稿全文，正文已经由服务端单独推过 delta，
            // 这里只留元信息，避免面板里再存一份完整答案。
            onTrace?.({
              kind: "reflection_revised",
              adopted: event.adopted === true,
              improved: event.improved === true,
              beforeAverage:
                typeof event.beforeAverage === "number" ? event.beforeAverage : 0,
              afterAverage:
                typeof event.afterAverage === "number" ? event.afterAverage : 0,
              reason: asString(event.reason) ?? "",
            });
            continue;
          }
          if (event.type === "reflection_skipped") {
            onTrace?.({
              kind: "reflection_skipped",
              reason: asString(event.reason) ?? "unknown",
              detail: asString(event.detail) ?? "",
            });
            continue;
          }

          if (typeof event.delta === "string" && event.delta) {
            onDelta(event.delta);
            continue;
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "流式读取失败");
    return false;
  }
  return true;
}

/**
 * 人工确认放行/拒绝。
 * 只通知服务端 resolve(wait)；不负责执行工具或拉新回复。
 * 单 Agent（/api/chat）与多 Agent（/api/chat/multi）共用本接口。
 */
export async function confirmChatTool(params: ConfirmChatParams): Promise<void> {
  const response = await fetch("/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `确认失败：${response.status}`);
  }
}

/**
 * 普通对话流式聊天。
 * endpoint 由 multiAgent 决定；searchDocs 只进请求体，不参与选路。
 */
export async function streamChat({
  messages,
  model,
  signal,
  searchDocs,
  multiAgent = true,
  contextSummary,
  userId,
  allowMemory = false,
  onDelta,
  onTrace,
  onUsage,
  onContextCompacted,
  onError,
}: StreamChatParams): Promise<boolean> {
  const endpoint = multiAgent ? "/api/chat/multi" : "/api/chat";
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        model,
        searchDocs: Boolean(searchDocs),
        // 摘要只在普通对话链路生效；服务端校验不过就当没有摘要，不报错。
        contextSummary: contextSummary ?? null,
        // 记忆：关掉时连 userId 一起不带，服务端直接零注入。
        ...(allowMemory && userId ? { userId, allowMemory: true } : { allowMemory: false }),
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "网络请求失败");
    return false;
  }

  if (!response.ok) {
    onError(`服务异常：${response.status}`);
    return false;
  }
  if (!response.body) {
    onError("当前浏览器不支持流式响应");
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") return true;
          try {
            const event = JSON.parse(payload) as {
              delta?: string;
              error?: string;
              type?: string;
              name?: string;
              arguments?: unknown;
              result?: unknown;
              confirmId?: string;
              toolCallId?: string;
              action?: "allow" | "deny" | "block" | "flag";
              label?: string;
              reason?: string;
              disagree?: boolean;
              level?: string;
              rules?: string[];
              matchedFingerprints?: string[];
              code?: string;
              count?: number;
              mimeTypes?: unknown[];
              totalBytes?: number;
              imageCount?: number;
              imageBytes?: number;
              estimatedImageTokens?: number;
              mode?: string;
              surface?: string;
              guard?: { level?: string; rules?: string[] };
              judge?: {
                status?: string;
                risk?: string;
                confidence?: number;
                categories?: string[];
                shortReason?: string;
                errorKind?: string;
              };
              meta?: { durationMs?: number; truncated?: boolean };
              totalTokens?: number;
              promptTokens?: number;
              completionTokens?: number;
              llmCalls?: number;
              estimatedCostUsd?: number;
              model?: string;
              endpoint?: UsageSnapshot["endpoint"];
              itemIds?: string[];
              tokens?: number;
              items?: Array<{ id?: string; key?: string; value?: string; similarity?: number }>;
              candidates?: number;
              stored?: Array<{ id?: string; key?: string; value?: string }>;
            };
            if (event.error) {
              onError(event.error);
              return true;
            }
            if (event.type === "usage" && typeof event.totalTokens === "number") {
              onUsage?.({
                endpoint: event.endpoint,
                model: event.model ?? model,
                promptTokens: event.promptTokens ?? 0,
                completionTokens: event.completionTokens ?? 0,
                totalTokens: event.totalTokens,
                llmCalls: event.llmCalls ?? 1,
                estimatedCostUsd: event.estimatedCostUsd ?? 0,
                imageCount: event.imageCount ?? 0,
                imageBytes: event.imageBytes ?? 0,
                estimatedImageTokens: event.estimatedImageTokens ?? 0,
              });
            }
            if (event.type === "tool_call" && event.name) {
              onTrace?.({ kind: "tool_call", name: event.name, arguments: event.arguments });
            }
            if (event.type === "tool_result" && event.name) {
              onTrace?.({ kind: "tool_result", name: event.name, result: event.result });
            }
            if (event.type === "injection_detected") {
              onTrace?.({
                kind: "injection_detected",
                level: event.level,
                rules: Array.isArray(event.rules) ? event.rules : [],
              });
            }
            if (event.type === "judge_shadow") {
              onTrace?.({
                kind: "judge_shadow",
                mode: event.mode ?? "shadow",
                surface: event.surface ?? "input",
                guard: {
                  level: event.guard?.level ?? "none",
                  rules: Array.isArray(event.guard?.rules) ? event.guard.rules : [],
                },
                judge: {
                  status: event.judge?.status ?? "error",
                  risk: event.judge?.risk,
                  confidence: event.judge?.confidence,
                  categories: Array.isArray(event.judge?.categories)
                    ? event.judge.categories
                    : [],
                  shortReason: event.judge?.shortReason,
                  errorKind: event.judge?.errorKind,
                },
                meta: {
                  durationMs: event.meta?.durationMs,
                  truncated: event.meta?.truncated === true,
                },
              });
            }
            if (event.type === "judge_enforced") {
              onTrace?.({
                kind: "judge_enforced",
                mode: event.mode ?? "enforce",
                surface: event.surface ?? "input",
                guard: {
                  level: event.guard?.level ?? "none",
                  rules: Array.isArray(event.guard?.rules) ? event.guard.rules : [],
                },
                judge: {
                  status: event.judge?.status ?? "error",
                  risk: event.judge?.risk,
                  confidence: event.judge?.confidence,
                  categories: Array.isArray(event.judge?.categories)
                    ? event.judge.categories
                    : [],
                  shortReason: event.judge?.shortReason,
                  errorKind: event.judge?.errorKind,
                },
                action: event.action ?? "allow",
                label: event.label,
                reason: event.reason,
                disagree: event.disagree === true,
                meta: {
                  durationMs: event.meta?.durationMs,
                  truncated: event.meta?.truncated === true,
                },
              });
            }
            if (event.type === "output_leak_blocked") {
              onTrace?.({
                kind: "output_leak_blocked",
                matchedFingerprints: Array.isArray(event.matchedFingerprints)
                  ? event.matchedFingerprints
                  : [],
              });
            }
            if (event.type === "vision_attachment") {
              onTrace?.({
                kind: "vision_attachment",
                count: typeof event.count === "number" ? event.count : 0,
                mimeTypes: Array.isArray(event.mimeTypes)
                  ? event.mimeTypes.filter((item): item is string => typeof item === "string")
                  : [],
                totalBytes: typeof event.totalBytes === "number" ? event.totalBytes : 0,
                estimatedImageTokens:
                  typeof event.estimatedImageTokens === "number"
                    ? event.estimatedImageTokens
                    : 0,
              });
            }
            if (event.type === "vision_rejected" && typeof event.code === "string") {
              onTrace?.({
                kind: "vision_rejected",
                code: event.code as VisionErrorCode,
                reason: typeof event.reason === "string" ? event.reason : "图片被拒绝",
              });
            }
            if (event.type === "vision_unsupported_model") {
              onTrace?.({
                kind: "vision_unsupported_model",
                model: typeof event.model === "string" ? event.model : model,
              });
            }
            // 记忆事件（注入 / 抽取 / 失败）：与其它三条链路共用同一份解析。
            const memoryStep = parseMemoryTraceStep(event);
            if (memoryStep) onTrace?.(memoryStep);
            if (
              event.type === "pending_confirm" &&
              event.name &&
              event.confirmId &&
              event.toolCallId
            ) {
              onTrace?.({
                kind: "pending_confirm",
                confirmId: event.confirmId,
                toolCallId: event.toolCallId,
                name: event.name,
                arguments: event.arguments,
                status: "pending",
              });
            }
            if (
              event.type === "confirm_resolved" &&
              event.toolCallId &&
              (event.action === "allow" || event.action === "deny")
            ) {
              onTrace?.({
                kind: "confirm_resolved",
                toolCallId: event.toolCallId,
                name: event.name ?? "",
                action: event.action,
              });
            }
            // 上下文压缩事件：独立分支处理，处理完就跳过，
            // 保证它既不会进 onDelta，也不会被当作未知事件丢掉。
            if (event.type === "context_compacted") {
              const compaction = parseContextCompactionEvent(
                event as unknown as Record<string, unknown>,
              );
              if (compaction) onContextCompacted?.(compaction);
              continue;
            }
            if (event.delta) onDelta(event.delta);
          } catch {
            // 忽略无法解析的中间数据
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) return false;
    onError(error instanceof Error ? error.message : "流式读取失败");
    return false;
  }
  return true;
}

/**
 * 消费结构化输出 SSE。
 *
 * 只把完整快照交给 UI；structured_delta 仅报告服务端接收进度。
 * 返回 false 表示请求失败、协议提前结束或调用方主动中止。
 */
export async function streamStructured({
  messages,
  model,
  target,
  userId,
  allowMemory = false,
  signal,
  onSnapshot,
  onDone,
  onTrace,
  onUsage,
  onError,
}: StreamStructuredParams): Promise<boolean> {
  // 1. 发起结构化请求；主动 abort 不转换成用户可见网络错误。
  let response: Response;
  try {
    response = await fetch("/api/chat/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        model,
        target,
        // 记忆：关掉时连 userId 一起不带，服务端直接零注入。
        ...(allowMemory && userId
          ? { userId, allowMemory: true }
          : { allowMemory: false }),
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return false;
    onError({
      code: "model_request_failed",
      message: error instanceof Error ? error.message : "网络请求失败",
      retryable: true,
      lastRevision: 0,
    });
    return false;
  }

  if (!response.ok) {
    // 2. HTTP 层失败先归类；只有 5xx 默认标记为可重试。
    onError({
      code: "model_request_failed",
      message: `服务异常：${response.status}`,
      retryable: response.status >= 500,
      lastRevision: 0,
    });
    return false;
  }
  if (!response.body) {
    // 浏览器不支持 ReadableStream 时无法消费 SSE，不是网络重试问题。
    onError({
      code: "model_request_failed",
      message: "当前浏览器不支持流式响应",
      retryable: false,
      lastRevision: 0,
    });
    return false;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastRevision = 0;
  let pendingDoneEvent: StructuredDoneEvent | null = null;
  let warnedUnknownEvent = false;

  try {
    // 3. 按网络 chunk 读取，再用空行切出完整 SSE event。
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) return false;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          // 只消费 data 行；其他 SSE 字段和心跳不进入业务协议。
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            // [DONE] 只有在前面已经收到 structured_done 时才算成功。
            if (pendingDoneEvent) {
              onDone(pendingDoneEvent);
              return true;
            }
            onError({
              code: "model_stream_interrupted",
              message: "结构化流缺少完成事件",
              retryable: true,
              lastRevision,
            });
            return false;
          }

          let event: { type?: string } & Record<string, unknown>;
          try {
            // 单个损坏事件不能清空已收到的快照，因此解析失败时继续读取后续事件。
            const parsed = JSON.parse(payload) as unknown;
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              Array.isArray(parsed)
            ) {
              continue;
            }
            event = parsed as { type?: string } & Record<string, unknown>;
          } catch {
            // 单个损坏事件不应破坏已收到的快照，继续读取后续事件。
            continue;
          }

          if (event.type === "structured_snapshot") {
            // 4. snapshot 是唯一增量渲染源；revision 由 Vue 状态层再次去重。
            const snapshotEvent = event as unknown as StructuredSnapshotEvent;
            lastRevision = snapshotEvent.revision;
            onSnapshot(snapshotEvent);
            continue;
          }
          if (event.type === "structured_done") {
            // done 先暂存，等看到 [DONE] 后才提交，防止响应在哨兵前中断。
            const doneEvent = event as unknown as StructuredDoneEvent;
            lastRevision = doneEvent.revision;
            pendingDoneEvent = doneEvent;
            continue;
          }
          if (event.type === "usage" && typeof event.totalTokens === "number") {
            // usage 与业务结果解耦，缺失时仍允许结构化请求完成。
            onUsage?.({
              endpoint: event.endpoint as UsageSnapshot["endpoint"],
              model: typeof event.model === "string" ? event.model : model,
              promptTokens:
                typeof event.promptTokens === "number" ? event.promptTokens : 0,
              completionTokens:
                typeof event.completionTokens === "number"
                  ? event.completionTokens
                  : 0,
              totalTokens: event.totalTokens,
              llmCalls: typeof event.llmCalls === "number" ? event.llmCalls : 1,
              estimatedCostUsd:
                typeof event.estimatedCostUsd === "number"
                  ? event.estimatedCostUsd
                  : 0,
              imageCount:
                typeof event.imageCount === "number" ? event.imageCount : 0,
              imageBytes:
                typeof event.imageBytes === "number" ? event.imageBytes : 0,
              estimatedImageTokens:
                typeof event.estimatedImageTokens === "number"
                  ? event.estimatedImageTokens
                  : 0,
            });
            continue;
          }
          if (event.type === "structured_error") {
            // 5. 服务端错误码原样交给状态层，由组件映射成用户文案。
            onError({
              code:
                typeof event.code === "string"
                  ? (event.code as StructuredClientError["code"])
                  : "model_stream_interrupted",
              message:
                typeof event.message === "string"
                  ? event.message
                  : "结构化输出失败",
              retryable:
                typeof event.retryable === "boolean" ? event.retryable : false,
              lastRevision:
                typeof event.lastRevision === "number"
                  ? event.lastRevision
                  : lastRevision,
            });
            return false;
          }
          // 记忆事件：结构化链路的注入 / 抽取 / 失败与其它三条链路同形状。
          const memoryStep = parseMemoryTraceStep(event);
          if (memoryStep) {
            onTrace?.(memoryStep);
            continue;
          }
          if (
            // start/delta 已由状态机隐式处理；未知事件只在开发环境提示一次。
            event.type !== "structured_start" &&
            event.type !== "structured_delta" &&
            event.type !== "usage" &&
            // 记忆事件（memory_injected / memory_extracted / memory_failed）
            // 与结构化协议无关：面板展示归前端契约那一版处理，
            // 这里先认下来，避免开发环境误报「未知事件」。
            event.type !== "memory_injected" &&
            event.type !== "memory_extracted" &&
            event.type !== "memory_failed" &&
            !warnedUnknownEvent &&
            import.meta.env?.DEV
          ) {
            warnedUnknownEvent = true;
            console.warn("忽略未知的结构化流事件", event.type);
          }
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    // 用户停止不是错误；其余读取异常保留最后 revision，便于 UI 展示部分结果。
    if (signal.aborted) return false;
    onError({
      code: "model_stream_interrupted",
      message: error instanceof Error ? error.message : "流式读取失败",
      retryable: true,
      lastRevision,
    });
    return false;
  }

  // 网络流正常 EOF 但没看到 [DONE]，仍视为协议中断而不是成功。
  onError({
    code: "model_stream_interrupted",
    message: "结构化流在完成事件前断开",
    retryable: true,
    lastRevision,
  });
  return false;
}

/** 读取服务端 mock/api 模式；失败返回 null，由页面显示“连接中”。 */
export async function fetchHealth(): Promise<HealthInfo | null> {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return null;
    return (await response.json()) as HealthInfo;
  } catch {
    return null;
  }
}
