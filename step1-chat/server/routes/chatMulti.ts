import type { Express } from "express";
import { buildContext, renderMemoryText, renderSummaryText } from "../context/buildContext.js";
import { maybeSummarize } from "../context/summarize.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  resolveBudgetTokens,
} from "../context/tokenBudget.js";
import type { ContextSummary } from "../context/types.js";
import { detectInjection } from "../guard/inputGuard.js";
import { SAFE_BLOCK_TEXT } from "../guard/judgePolicy.js";
import { runInputJudge } from "../guard/judgeRuntime.js";
import {
  buildExtractionInput,
  retrieveMemoryBlock,
  scheduleMemoryExtraction,
} from "../memory/bridge.js";
import { isValidUserId } from "../memory/types.js";
import { compileMultiAgentGraph } from "../multi-agent/graph.js";
import { ConfirmSession } from "../react/confirmGate.js";
import type { TextMessage, ToolTraceHandler } from "../react/types.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { runMultiRequestWithTracing } from "../tracing/langsmith.js";
import { bindUsageCallback, UsageAccumulator } from "../usage/accumulator.js";
import { isVisionCapableModel } from "../vision/capability.js";
import { estimateImageTokens } from "../vision/estimateImageTokens.js";
import { validateRequestMessages } from "../vision/validateRequestMessages.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

/**
 * 多 Agent 聊天入口：SSE。
 *
 * 与 /api/chat（单 Agent ReAct）并存。前端勾选「多 Agent」时走此端点（见 src/api/chat.ts）。
 *
 * 服务端流程（graph 内部，见 multi-agent/graph.ts）：
 *   用户最后一句 → Supervisor 路由 → Worker 并行 → Aggregate 汇总
 *
 * 人工确认（与单 Agent 共用 ConfirmSession + POST /api/chat/confirm）：
 *   - 本请求 new ConfirmSession()，经 graph options 下传给 Workers
 *   - actionWorker 调 draft_message 时 runToolSafely 会 await wait
 *   - **必须**在 graph.invoke 进行中写 SSE（pending_confirm 等）；不能等整图结束再推
 *   - finally dispose，避免 wait 泄漏
 *
 * SSE 事件顺序（本 handler / graph 中途写出）：
 *   0. injection_detected（可选）— inputGuard 命中，只标记不拦截
 *   1. memory_injected（可选）— 本轮注入了哪几条长期记忆
 *   2. supervisor_route  — 路由到了哪些 Worker（invoke 中途）
 *   3.（若需确认）tool_call → pending_confirm → confirm_resolved → tool_result
 *   4. worker_done × N   — 每个 Worker 调了哪些工具（invoke 中途）
 *   5. delta             — Aggregate 后的最终回复（整段，非流式逐字；已过 outputGuard）
 *   6. usage             — Supervisor+Worker+Aggregate token 合计
 *   7. [DONE]
 *
 * 防护层（与单 Agent 对齐）：
 *   inputGuard → 本文件；toolCallGuard → Worker runToolSafely；outputGuard → aggregate
 *
 * LangSmith（与 chat-request / rag-request 并列）：
 *   runMultiRequestWithTracing → multi-supervisor / multi-workers / multi-aggregate
 *   callLLM → multi-llm；runToolSafely → runToolWithTracing（tool）
 *
 * 前端勾选「搜索知识库」时：
 *   body.searchDocs=true → graph.forceKbSearch → Supervisor 后若无 kb 则强制追加
 *   由 kbWorker 调 searchDocs（与单 Agent 语义 C 的 prefetch 路径不同，但保证必检索）
 *
 * 流程图：docs/multi-agent-human-confirm-flow.svg
 */
export function registerChatMultiRoutes(app: Express): void {
  app.post("/api/chat/multi", async (req, res) => {
    setSseHeaders(res);

    const { messages, model, searchDocs, userId, allowMemory } = req.body ?? {};

    // ---- 步骤 1：校验 messages（至少一条，含 user 角色）----
    if (!Array.isArray(messages) || messages.length === 0) {
      res.write(`data: ${JSON.stringify({ error: "messages 必须是非空数组" })}\n\n`);
      res.end();
      return;
    }

    // ---- 步骤 1.1：图片附件二次校验（不信前端）----
    // 校验失败：不建 UsageAccumulator、不进 graph，直接回 vision_rejected。
    const attachmentCheck = validateRequestMessages(messages);
    if (!attachmentCheck.ok) {
      res.write(
        `data: ${JSON.stringify({
          type: "vision_rejected",
          code: attachmentCheck.code,
          reason: attachmentCheck.reason,
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ error: attachmentCheck.reason })}\n\n`);
      res.end();
      return;
    }

    // 多 Agent 图只吃「当前这一轮」的用户问句，history 暂不传入 Supervisor
    const lastUser = [...messages].reverse().find((m: { role: string }) => m.role === "user");
    if (!lastUser || !lastUser.content) {
      res.write(`data: ${JSON.stringify({ error: "未找到用户消息" })}\n\n`);
      res.end();
      return;
    }

    const userText = typeof lastUser.content === "string" ? lastUser.content : "";

    // ---- 步骤 2：用户断开连接时中止 graph 内所有 LLM fetch / 确认 wait ----
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    // ---- 步骤 2.5：本请求确认会话（构造时写入 sessions Map）----
    // 前端 pending_confirm.confirmId → POST /api/chat/confirm → getConfirmSession 取回同一实例
    const confirmSession = new ConfirmSession();

    // invoke 进行中写 SSE 的闭包（supervisor_route / worker_done / onTrace 共用）
    const writeSse = (payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // 工具过程事件形状与单 Agent 一致（type 字段），直接当 SSE payload
    const onTrace: ToolTraceHandler = (event) => {
      writeSse(event as unknown as Record<string, unknown>);
    };

    try {
      const config = getRuntimeConfig();
      const defaultModel = typeof model === "string" && model ? model : config.model;

      // ---- 步骤 2.5.5：Vision 事件（有合法附件才推；无图完全静默）----
      let visionStats: {
        count: number;
        totalBytes: number;
        estimatedTokens: number;
      } | null = null;
      const withImages = messages.filter(
        (message: { attachments?: unknown[] }) =>
          Array.isArray(message.attachments) && message.attachments.length > 0,
      );
      if (withImages.length > 0) {
        const attachments = withImages.flatMap(
          (message: {
            attachments: Array<{
              mimeType?: string;
              byteSize?: number;
              width?: number;
              height?: number;
            }>;
          }) => message.attachments ?? [],
        );
        visionStats = {
          count: attachments.length,
          totalBytes: attachments.reduce(
            (sum, a) => sum + (a.byteSize ?? 0),
            0,
          ),
          estimatedTokens: attachments.reduce(
            (sum, a) => sum + estimateImageTokens(a.width ?? 0, a.height ?? 0),
            0,
          ),
        };
        writeSse({
          type: "vision_attachment",
          count: attachments.length,
          mimeTypes: [...new Set(attachments.map((a) => a.mimeType ?? ""))],
          totalBytes: visionStats.totalBytes,
          estimatedImageTokens: visionStats.estimatedTokens,
        });
        if (!isVisionCapableModel(defaultModel)) {
          writeSse({ type: "vision_unsupported_model", model: defaultModel });
          writeSse({ error: `当前模型 ${defaultModel} 不支持图片输入` });
          res.end();
          return;
        }
      }

      // ---- 步骤 2.6：inputGuard — 只标记不拦截（与单 Agent chat 链路一致）----
      const injection = detectInjection(userText);
      if (injection.level !== "none") {
        console.warn(`[InputGuard] multi level=${injection.level} rules=${injection.matchedRules.join(",")}`);
        writeSse({
          type: "injection_detected",
          level: injection.level,
          rules: injection.matchedRules,
        });
      }

      // ---- Token 累加器（先建好，Judge 拦截时也能写一份 0 用量）----
      const accumulator = new UsageAccumulator();
      // ---- 步骤 9：图片成本进 usage（只记数字，不记 base64）----
      if (visionStats) {
        accumulator.recordImages(visionStats);
      }

      // ---- LLM-as-Judge：默认 off 不调用 ----
      // - shadow：只写 judge_shadow 事件，主回答不变
      // - enforce：命中拦截策略时直接回安全文案，不进 graph
      const judgeOutcome = await runInputJudge({
        text: userText,
        guard: { level: injection.level, rules: injection.matchedRules },
        emit: (event) => writeSse(event as unknown as Record<string, unknown>),
      });
      if (judgeOutcome.action === "block") {
        writeSse({ delta: judgeOutcome.safeText ?? SAFE_BLOCK_TEXT });
        writeUsageToStream(res, accumulator, "chat/multi", defaultModel);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ---- 步骤 3.5：长期记忆 — 路由层检索一次，四个 Worker 共用同一块 ----
      // 放在 judge 之后：被拦截的输入不该触发任何记忆检索。
      // 关闭开关 / userId 非法时 retrieveMemoryBlock 直接返回 null（零检索）。
      const memoryOptions = {
        userId: isValidUserId(userId) ? userId : undefined,
        allowMemory: allowMemory === true,
        model: defaultModel,
        onTrace,
        onMemoryUsage: bindUsageCallback(accumulator, "memory", defaultModel),
      };
      const memoryBlock = await retrieveMemoryBlock(memoryOptions, userText);
      if (memoryBlock) {
        writeSse({
          type: "memory_injected",
          itemIds: memoryBlock.items.map((item) => item.id),
          tokens: estimateMessageTokens({
            role: "system",
            content: renderMemoryText(memoryBlock),
          }),
          items: memoryBlock.items.map((item) => ({
            id: item.id,
            key: item.key ?? "",
            value: item.value ?? "",
            similarity: item.similarity,
          })),
        });
      }

      // ---- 步骤 3.6：长上下文压缩 — 只压历史，只下发给 Worker ----
      // 口径与 Supervisor / Aggregate 无关：路由判断只看当前问句、汇总不产生新事实，
      // 所以压缩后的历史（近期原文层）与摘要都只经 graph options 下发给 Worker。
      // 历史为空（首轮）→ 零开销，跳过整段。
      // 注意：当前问句（lastUser）由 Worker 以 task 形式单独收到，
      // 不进 historyMessages，避免与 task 重复。
      // 找到最后一条 user 消息的下标：它之前的内容才是「历史」。
      // lastUser 是从 messages 里 find 出来的原元素引用，lastIndexOf 按引用可靠匹配。
      const lastUserIndex = messages.lastIndexOf(lastUser);
      const rawHistory = (
        messages as Array<{ role: string; content: string; attachments?: unknown[] }>
      ).filter(
        (message, index) =>
          index < lastUserIndex &&
          typeof message.content === "string" &&
          message.content.trim().length > 0 &&
          !Array.isArray(message.attachments), // 图片不跨轮（与单 Agent 清洗口径一致）
      ) as TextMessage[];

      let historyMessages: TextMessage[] = [];
      let contextSummary: ContextSummary | null = null;

      if (rawHistory.length > 0) {
        const budgetTokens = resolveBudgetTokens(
          config.context.windowTokens,
          config.context.budgetRatio,
        );
        // systemPrompt 传空：角色 system 由各 Worker 自己注入，这里只裁历史；
        // memory 传 null：记忆已由 Worker 自己注入，不在这里重复算预算。
        let context = buildContext({
          messages: rawHistory,
          summary: null,
          systemPrompt: "",
          budgetTokens,
        });

        // 只有真的丢掉内容才生成摘要 + 推事件，避免每轮制造噪音。
        if (context.droppedMessages.length > 0) {
          const originalTokens = estimateMessagesTokens(context.droppedMessages);
          const compactedRounds = context.droppedMessages.filter(
            (message) => message.role === "user",
          ).length;

          // Mock 模式不触发摘要生成（与单 Agent 一致）：没有真实模型，不该多等一次网络往返。
          contextSummary = config.forceMock
            ? null
            : await maybeSummarize({
                context,
                previousSummary: null,
                apiKey: config.apiKey,
                baseUrl: config.baseUrl,
                model: defaultModel,
                signal: abortController.signal,
                onUsage: bindUsageCallback(accumulator, "summary", defaultModel),
              });

          if (contextSummary) {
            // 用新摘要重建：摘要覆盖范围内的旧消息不再重复注入。
            context = buildContext({
              messages: rawHistory,
              summary: contextSummary,
              systemPrompt: "",
              budgetTokens,
            });
          }

          const summaryTokens = contextSummary
            ? estimateMessageTokens({
                role: "system",
                content: renderSummaryText(contextSummary),
              })
            : 0;

          writeSse({
            type: "context_compacted",
            compactedRounds,
            originalTokens,
            compactedTokens: context.estimatedTokens,
            summaryTokens,
            degraded: contextSummary === null || context.degraded,
            summary: contextSummary,
          });
        }

        // 只取近期原文层（buildContext 输出里非 system 的部分）。
        historyMessages = context.messages.filter(
          (message) => message.role !== "system",
        );
      }

      // ---- 步骤 3：累加器在 Judge 之前已建好，这里注入 graph ----
      // graph 内每次 callLLM → parseUsage → onUsage(source) → accumulator.record()
      // 可能：Supervisor 1 次 + Worker 各 1~N 次 + Aggregate 0~1 次
      // ---- 步骤 4：编译并执行 LangGraph（LangSmith 根 span：multi-request）----
      // 注意：Supervisor / Worker 过程事件在 invoke **进行中**经 writeSse/onTrace 写出；
      // 不能再「整图跑完才推 route/done」，否则确认 wait 时前端收不到 pending_confirm。
      // confirm wait 期间根 span 仍开着（与单 Agent chat-request 一致）。
      const graph = compileMultiAgentGraph({
        accumulator,
        defaultModel,
        confirmSession,
        onTrace,
        writeSse,
        // 勾选「搜索知识库」→ 强制带上 kb Worker（Supervisor 漏分时补上）
        forceKbSearch: searchDocs === true,
        // 记忆块：只下发给 Worker，Supervisor / Aggregate 不注入
        memoryBlock: memoryBlock ?? undefined,
        // 压缩后的近期原文 + 摘要：只下发给 Worker，Supervisor / Aggregate 不注入
        historyMessages,
        contextSummary,
      });

      await runMultiRequestWithTracing(userText, async () => {
        const result = await graph.invoke({
          userMessage: userText,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: typeof model === "string" && model ? model : undefined,
          signal: abortController.signal,
          routeDecision: null,
          workerResults: [],
          finalOutput: null,
        });

        // ---- 步骤 5：最终回复（route / worker_done / 确认事件已在 invoke 中途写出）----
        // 单 Worker 成功时可能是透传，无二次 Aggregate LLM
        const finalText = result.finalOutput ?? "";
        writeSse({ delta: finalText });

        // ---- 步骤 5.5：长期记忆抽取（旁路，不阻塞本轮回复）----
        // 抽取输入按统一口径裁剪：最近 2 轮**用户消息** + 给用户的最终回复。
        // Worker 的工具返回、Supervisor 的路由 JSON 都不参与抽取——
        // 那些是过程产物，不是用户事实。
        scheduleMemoryExtraction(
          memoryOptions,
          buildExtractionInput({ messages, finalReply: finalText }),
          {
            apiKey: config.apiKey,
            forceMock: config.forceMock,
            baseUrl: config.baseUrl,
          },
        );

        // ---- 步骤 6：Token — 写 store + 推 usage ----
        writeUsageToStream(res, accumulator, "chat/multi", defaultModel);

        // ---- 步骤 7：结束 SSE ----
        res.write("data: [DONE]\n\n");
        res.end();
      });
    } catch (error) {
      if (!res.writableEnded) {
        const message = error instanceof Error ? error.message : "未知错误";
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    } finally {
      // 未决 wait 按 deny 解开，并从 sessions Map 删除
      confirmSession.dispose();
    }
  });
}
