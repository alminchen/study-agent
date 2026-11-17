/**
 * Reflection 聊天入口：POST /api/chat/reflection（SSE）。
 *
 * 与 /api/chat（单 Agent ReAct）、/api/chat/plan（Plan-and-Execute）并存，
 * 三条链路各自独立，本文件不改写任何既有链路。
 *
 * ## 为什么要单独一条端点
 *
 * Reflection 的语义是「先出一版答案，再回头打分，必要时重写」——
 * 答案可能在生成之后被替换掉。如果把它塞进 /api/chat 的 ReAct 循环里，
 * 就得改那条链路的状态机，风险与调试成本都不小。单独开一条端点，
 * 现有链路一行不动，Reflection 想关就关。
 *
 * ## 流程
 *
 *   校验 → 生成 draft（复用 createChatStream，不改 ReAct 图）
 *        → Critic 评分 →（低于阈值）重写 → 重评
 *        → 比分数决定用哪一版 → 推正文 → usage → [DONE]
 *
 * ## 事件顺序
 *
 *   tool_call / tool_result …（ReAct 过程事件，原样透传）
 *   → reflection_scored（初评）
 *   → reflection_revised（产出了修订稿时）
 *   → reflection_skipped（任何一条没有走到重写/没有采纳的分支）
 *   → delta（最终正文，一次性推完）
 *   → usage → [DONE]
 *
 * ## 两个刻意的设计取舍
 *
 * 1. 正文不流式推，等 Reflection 全部结束后一次性推。
 *    因为正文可能被替换：先流式推 draft、后面再换成修订稿，
 *    前端正文就会出现两段拼接。宁可正文晚一点出现，也要保证读到的是终稿。
 *
 * 2. 影子模式（shadow）只报告不改正文。
 *    这是「自我评估偏差」实验的前提：先观察 Critic 说得准不准，
 *    再决定要不要让它真的改答案。enforce 模式才允许修订稿成为正文。
 */
import type { Express } from "express";
import { z } from "zod";
import { createChatStream } from "../chat.js";
import { renderMemoryText } from "../context/buildContext.js";
import { estimateMessageTokens } from "../context/tokenBudget.js";
import {
  buildExtractionInput,
  buildMemoryInjectedEvent,
  retrieveMemoryBlock,
  scheduleMemoryExtraction,
} from "../memory/bridge.js";
import { isValidUserId, type MemoryTraceEvent } from "../memory/types.js";
import {
  averageScore,
  critique,
  shouldRewriteByThreshold,
  type CritiqueInput,
  type CriticMeta,
} from "../reflection/critic.js";
import {
  revise,
  type ReviseInput,
  type ReviseMeta,
  type ReviseResult,
} from "../reflection/revise.js";
import type {
  Critique,
  CritiqueIssue,
  CritiqueScores,
} from "../reflection/types.js";
import { ConfirmSession } from "../react/confirmGate.js";
import { getRuntimeConfig, type ReflectionMode } from "../runtimeConfig.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
import { parseUsageFromResponse } from "../usage/parseUsage.js";
import type { TokenUsage } from "../usage/types.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

export type { ReflectionMode };

/**
 * 请求体契约。
 *
 * 与 /api/chat 的区别：这里收的是「一个问题 + 会话 id」，
 * 不是完整 messages 数组。Reflection 是对单轮答案做复盘，
 * 不需要承担多轮上下文的拼接职责。
 */
export const ReflectionChatRequestSchema = z.object({
  question: z.string().min(1),
  /** 前端会话标识，用于把一次复盘串回具体会话。 */
  sessionId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /**
   * 单次请求指定模式；只能把服务端模式往下调（enforce → shadow），
   * 不能往上抬。最终生效的模式见服务端日志。
   */
  mode: z.enum(["shadow", "enforce"]).optional(),
  searchDocs: z.boolean().optional(),
  /** 匿名用户 id（跨会话记忆的归属键）；非法 id 按「没开记忆」处理。 */
  userId: z.string().optional(),
  /** 是否启用记忆；false / 不传时零检索、零抽取。 */
  allowMemory: z.boolean().optional(),
});

/** 评分与重写的过程元信息；面板用来判断「截断了没有、重试了几次」。 */
export interface ReflectionMeta {
  durationMs: number;
  attempts: number;
  truncated: boolean;
}

/** 初评或重评成功。 */
export interface ReflectionScoredEvent {
  type: "reflection_scored";
  /** initial = 初评；revised = 对修订稿的重评。 */
  stage: "initial" | "revised";
  scores: CritiqueScores;
  average: number;
  issues: CritiqueIssue[];
  /** 按阈值算出来的「是否值得重写」结论，不是模型自说自话。 */
  shouldRewrite: boolean;
  reason: string;
  meta: ReflectionMeta;
}

/** 产出了修订稿。 */
export interface ReflectionRevisedEvent {
  type: "reflection_revised";
  /** 是否把修订稿作为最终正文；影子模式下恒为 false。 */
  adopted: boolean;
  /** 修订稿的平均分是否高于初版。 */
  improved: boolean;
  /** 修订后的完整答案。 */
  revisedText: string;
  beforeAverage: number;
  afterAverage: number;
  reason: string;
}

/** 跳过的原因；面板用它解释「为什么没有重写 / 为什么没改」。 */
export type ReflectionSkipReason =
  | "off"
  | "mock_mode"
  | "critique_failed"
  | "no_rewrite_needed"
  | "revise_failed"
  | "revise_rejected"
  | "revise_no_change"
  | "rescore_failed"
  | "no_improvement"
  | "shadow_mode";

export interface ReflectionSkippedEvent {
  type: "reflection_skipped";
  reason: ReflectionSkipReason;
  detail: string;
}

export type ReflectionEvent =
  | ReflectionScoredEvent
  | ReflectionRevisedEvent
  | ReflectionSkippedEvent;

/** 评分 / 重写的可替换实现；测试注入假实现，不碰网络。 */
export interface ReflectionPipelineOptions {
  question: string;
  /** 初版答案。 */
  draft: string;
  /** 工具返回的事实；评分与重写都只认这里的内容。 */
  toolFacts?: string;
  mode: ReflectionMode;
  /** Mock 模式没有评审模型，直接跳过整个 Reflection。 */
  mockMode?: boolean;
  critique: (
    input: CritiqueInput,
    options: { onMeta?: (meta: CriticMeta) => void },
  ) => Promise<Critique>;
  revise: (
    input: ReviseInput,
    options: { onMeta?: (meta: ReviseMeta) => void },
  ) => Promise<ReviseResult>;
  onEvent: (event: ReflectionEvent) => void;
}

/**
 * 收敛服务端开关与请求里的模式。
 *
 * 服务端是上限，请求只能往下调不能往上抬：
 * - 服务端 off    → 一律 off，请求说了也没用（开关关了就是关了）
 * - 服务端 shadow → 一律 shadow，请求要 enforce 也不给（改写正文必须由配置显式放开）
 * - 服务端 enforce→ 请求可以退到 shadow 做对比
 *
 * 这么定是因为「谁有权改写用户看到的答案」应该是配置说了算，
 * 前端一次请求不该把 shadow 悄悄升级成 enforce。
 */
export function resolveReflectionMode(
  serverMode: ReflectionMode,
  requestedMode?: "shadow" | "enforce",
): ReflectionMode {
  if (serverMode === "off") return "off";
  if (serverMode === "shadow") return "shadow";
  return requestedMode ?? "enforce";
}

export interface ReflectionPipelineResult {
  /** 最终应该作为正文推给前端的答案。 */
  finalDraft: string;
  /** 初评结果；评分失败时为 null。 */
  initial: Critique | null;
  /** 对修订稿的重评结果；没走到重评时为 null。 */
  revised: Critique | null;
  /** 产出的修订稿；没产出时为 null。 */
  revisedDraft: string | null;
}

const EMPTY_META: ReflectionMeta = { durationMs: 0, attempts: 0, truncated: false };

function toMeta(meta: CriticMeta | ReviseMeta): ReflectionMeta {
  return {
    durationMs: meta.durationMs,
    attempts: meta.attempts,
    truncated: meta.truncated,
  };
}

/**
 * Reflection 决策流水线。
 *
 * 抽成独立函数是为了能脱离 Express 直接测：路由只管 HTTP 与 draft 生成，
 * 「评不评、要不要重写、用哪一版」这套决策全部在这里，一眼能看完。
 *
 * 每条没走到最终采纳的分支都会推一条 reflection_skipped，
 * 保证「为什么停下」永远有答案，不出现静默失败。
 */
export async function runReflectionPipeline(
  options: ReflectionPipelineOptions,
): Promise<ReflectionPipelineResult> {
  const { question, draft, toolFacts = "", mode, onEvent } = options;
  const result: ReflectionPipelineResult = {
    finalDraft: draft,
    initial: null,
    revised: null,
    revisedDraft: null,
  };

  if (mode === "off") {
    onEvent({
      type: "reflection_skipped",
      reason: "off",
      detail: "Reflection 模式为 off，直接返回初版答案",
    });
    return result;
  }

  if (options.mockMode) {
    onEvent({
      type: "reflection_skipped",
      reason: "mock_mode",
      detail: "Mock 模式没有可调用的评审模型，跳过 Reflection",
    });
    return result;
  }

  // ---- 初评 ----
  let initialMeta = EMPTY_META;
  const initial = await options.critique(
    { question, draft, toolFacts },
    { onMeta: (meta) => { initialMeta = toMeta(meta); } },
  );
  result.initial = initial;

  if (initial.status !== "ok") {
    onEvent({
      type: "reflection_skipped",
      reason: "critique_failed",
      detail: `评分失败（${initial.errorKind}），保留初版答案`,
    });
    return result;
  }

  const needRewrite = shouldRewriteByThreshold(initial);
  onEvent({
    type: "reflection_scored",
    stage: "initial",
    scores: initial.scores,
    average: averageScore(initial.scores),
    issues: initial.issues,
    shouldRewrite: needRewrite,
    reason: initial.reason,
    meta: initialMeta,
  });

  if (!needRewrite) {
    onEvent({
      type: "reflection_skipped",
      reason: "no_rewrite_needed",
      detail: "四项分数均高于阈值，不需要重写",
    });
    return result;
  }

  // ---- 重写 ----
  const revised = await options.revise(
    {
      question,
      draft,
      revisionInstructions: initial.revisionInstructions,
      toolFacts,
    },
    { onMeta: () => undefined },
  );

  if (revised.status === "error") {
    onEvent({
      type: "reflection_skipped",
      reason: "revise_failed",
      detail: `重写失败（${revised.errorKind}），保留初版答案`,
    });
    return result;
  }

  if (revised.status === "rejected") {
    onEvent({
      type: "reflection_skipped",
      reason: "revise_rejected",
      detail: `重写作废：${revised.reason}`,
    });
    return result;
  }

  if (revised.status === "no_change") {
    onEvent({
      type: "reflection_skipped",
      reason: "revise_no_change",
      detail: "重写结果与初版实质相同，无需再评一次",
    });
    return result;
  }

  result.revisedDraft = revised.revisedDraft;

  // ---- 重评：修订稿必须自己扛得住评分，否则回退 ----
  let revisedMeta = EMPTY_META;
  const rescore = await options.critique(
    { question, draft: revised.revisedDraft, toolFacts },
    { onMeta: (meta) => { revisedMeta = toMeta(meta); } },
  );
  result.revised = rescore;

  if (rescore.status !== "ok") {
    onEvent({
      type: "reflection_skipped",
      reason: "rescore_failed",
      detail: `修订稿重评失败（${rescore.errorKind}），回退初版答案`,
    });
    return result;
  }

  onEvent({
    type: "reflection_scored",
    stage: "revised",
    scores: rescore.scores,
    average: averageScore(rescore.scores),
    issues: rescore.issues,
    shouldRewrite: false,
    reason: rescore.reason,
    meta: revisedMeta,
  });

  const beforeAverage = averageScore(initial.scores);
  const afterAverage = averageScore(rescore.scores);
  const improved = afterAverage > beforeAverage;
  const adopted = improved && mode === "enforce";

  onEvent({
    type: "reflection_revised",
    adopted,
    improved,
    revisedText: revised.revisedDraft,
    beforeAverage,
    afterAverage,
    reason: improved
      ? "修订稿平均分高于初版"
      : "修订稿平均分未超过初版，回退初版答案",
  });

  if (adopted) {
    result.finalDraft = revised.revisedDraft;
    return result;
  }

  if (!improved) {
    onEvent({
      type: "reflection_skipped",
      reason: "no_improvement",
      detail: "修订稿没有优于初版，回退初版答案",
    });
    return result;
  }

  onEvent({
    type: "reflection_skipped",
    reason: "shadow_mode",
    detail: "影子模式只报告不改正文，保留初版答案",
  });
  return result;
}

/** 真实模型调用器参数。 */
export interface ReflectionModelCallerParams {
  apiKey: string;
  baseUrl: string;
  model: string;
  onUsage?: (usage: TokenUsage, model: string) => void;
}

/**
 * 给 Critic / Revise 用的真实模型调用器。
 *
 * 与 ReAct 的 askModel 的区别：请求里没有 tools 字段。
 * 评审与重写都不允许调用工具——重写要用的信息必须由调用方在
 * toolFacts 里给全，让模型自己去查就等于让被评估者给自己补证据。
 */
export function createReflectionModelCaller(
  params: ReflectionModelCallerParams,
) {
  return async (request: {
    system: string;
    user: string;
    signal: AbortSignal;
  }): Promise<string> => {
    const baseUrl = params.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        stream: false,
      }),
      signal: request.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Reflection 模型请求失败（${response.status}）`);
    }

    const data = JSON.parse(raw) as {
      choices?: { message?: { content?: string | null } }[];
    };
    const usage = parseUsageFromResponse(data);
    if (usage) params.onUsage?.(usage, params.model);

    return data.choices?.[0]?.message?.content ?? "";
  };
}

/** 把工具结果整理成评审可读的事实文本。 */
export function formatToolFact(name: string, result: unknown): string {
  const body =
    typeof result === "string" ? result : JSON.stringify(result ?? null);
  return `[${name}] ${body ?? ""}`;
}

export function registerChatReflectionRoutes(app: Express): void {
  app.post("/api/chat/reflection", async (req, res) => {
    // 先校验再声明 SSE：非法请求必须是 400 JSON，不能建模型请求，也不能开流。
    const parsed = ReflectionChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Reflection 请求参数不合法",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }

    const { question, sessionId, model, mode, searchDocs, userId, allowMemory } =
      parsed.data;
    setSseHeaders(res);

    // 客户端断开 → 中止模型请求。
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    // 确认会话在构造时登记，前端拿 pending_confirm.confirmId 走 /api/chat/confirm。
    const confirmSession = new ConfirmSession();

    const writeEvent = (payload: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // draft 提到 try 外面：生成阶段失败时，靠它降级返回初版答案。
    let draft = "";

    try {
      const config = getRuntimeConfig();
      const selectedModel = model || config.model;
      const usage = new UsageAccumulator();
      // 服务端 REFLECTION_MODE 是上限，请求里的 mode 只能往下调。
      const effectiveMode = resolveReflectionMode(config.reflection.mode, mode);

      // ---- 长期记忆：路由层检索一次，draft 与其后的评分/重写共用同一块 ----
      // 关闭开关 / userId 非法时 retrieveMemoryBlock 直接返回 null（零检索）。
      const memoryOptions = {
        userId: isValidUserId(userId) ? userId : undefined,
        allowMemory: allowMemory === true,
        model: selectedModel,
        onTrace: (event: MemoryTraceEvent) => writeEvent(event),
        onMemoryUsage: bindUsageCallback(usage, "memory", selectedModel),
      };
      const memoryBlock = await retrieveMemoryBlock(memoryOptions, question);
      if (memoryBlock) {
        writeEvent(
          buildMemoryInjectedEvent(
            memoryBlock.items.map((item) => ({
              id: item.id,
              key: item.key,
              value: item.value,
              similarity: item.similarity,
            })),
            estimateMessageTokens({
              role: "system",
              content: renderMemoryText(memoryBlock),
            }),
          ),
        );
      }

      // ---- 阶段一：生成 draft ----
      // 复用现成的 createChatStream（也就是现成的 ReAct 图）产出初版答案，
      // 不改动那条图；工具过程事件原样透传，工具结果收集成评审用的「事实」。
      const draftParts: string[] = [];
      const toolFacts: string[] = [];

      // memoryBlock 非 undefined：createChatStream 视为「提供方已查过」，
      // 不重复检索、不发事件、不自行抽取。
      await createChatStream({
        messages: [{ role: "user", content: question }],
        model: selectedModel,
        signal: abortController.signal,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        forceMock: config.forceMock,
        searchDocs: searchDocs === true,
        userId: memoryOptions.userId,
        allowMemory: memoryOptions.allowMemory,
        memoryBlock,
        confirmSession,
        onUsage: bindUsageCallback(usage, "askModel", selectedModel),
        // 先攒着不推：正文要以最终版本一次性给出。
        onDelta: (delta) => {
          draftParts.push(delta);
        },
        onTrace: (event) => {
          if (event.type === "tool_result") {
            toolFacts.push(formatToolFact(event.name, event.result));
          }
          writeEvent(event);
        },
      });

      draft = draftParts.join("");

      // ---- 阶段二：评分 →（必要时）重写 → 重评 ----
      const criticCaller = createReflectionModelCaller({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: selectedModel,
        onUsage: bindUsageCallback(usage, "critic", selectedModel),
      });
      const reviseCaller = createReflectionModelCaller({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: selectedModel,
        onUsage: bindUsageCallback(usage, "revise", selectedModel),
      });

      const pipeline = await runReflectionPipeline({
        question,
        draft,
        toolFacts: toolFacts.join("\n"),
        mode: effectiveMode,
        mockMode: config.mockMode,
        critique: (input, options) =>
          critique(input, { ...options, callModel: criticCaller }),
        revise: (input, options) =>
          revise(input, { ...options, callModel: reviseCaller }),
        onEvent: writeEvent,
      });

      console.log(
        `[reflection] ${JSON.stringify({
          session_id: sessionId ?? null,
          mode: effectiveMode,
          server_mode: config.reflection.mode,
          draft_chars: draft.length,
          final_chars: pipeline.finalDraft.length,
          adopted: pipeline.revisedDraft !== null && pipeline.finalDraft === pipeline.revisedDraft,
        })}`,
      );

      // ---- 长期记忆抽取（旁路，不阻塞本轮回复）----
      // 抽取只认「用户问题 + 最终采纳的答案」：评分/重写的中间产物、
      // 工具返回都不参与。关闭开关时 scheduleMemoryExtraction 内部直接返回。
      scheduleMemoryExtraction(
        memoryOptions,
        buildExtractionInput({
          messages: [{ role: "user", content: question }],
          finalReply: pipeline.finalDraft,
        }),
        {
          apiKey: config.apiKey,
          forceMock: config.forceMock,
          baseUrl: config.baseUrl,
        },
      );

      // ---- 阶段三：推最终正文 ----
      // 只推一次，推的是定稿（初版或被采纳的修订稿）。
      if (pipeline.finalDraft) writeEvent({ delta: pipeline.finalDraft });

      writeUsageToStream(res, usage, "chat/reflection", selectedModel);
      if (!res.writableEnded) res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      if (!res.writableEnded) {
        // 生成阶段失败但已经有部分 draft → 降级把它当作正文返回。
        if (draft) writeEvent({ delta: draft });
        const message = error instanceof Error ? error.message : "未知错误";
        writeEvent({ error: message });
        res.end();
      }
    } finally {
      confirmSession.dispose();
    }
  });
}
