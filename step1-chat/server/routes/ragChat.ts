import type { Express } from "express";
import { renderMemoryText } from "../context/buildContext.js";
import { estimateMessageTokens } from "../context/tokenBudget.js";
import { detectInjection } from "../guard/inputGuard.js";
import { SAFE_BLOCK_TEXT } from "../guard/judgePolicy.js";
import { runInputJudge } from "../guard/judgeRuntime.js";
import {
  buildExtractionInput,
  buildMemoryInjectedEvent,
  retrieveMemoryBlock,
  scheduleMemoryExtraction,
} from "../memory/bridge.js";
import { isValidUserId, type MemoryTraceEvent } from "../memory/types.js";
import { answerFromDocs } from "../rag/answer.js";
import type { RagMessage } from "../rag/prompt.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import {
  isLangSmithTracingEnabled,
  traceRagRequest,
} from "../tracing/langsmith.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

/** 只允许 user/assistant 进 RAG history；system 由服务端固定注入 */
function isRagHistoryItem(item: unknown): item is RagMessage {
  if (!item || typeof item !== "object") return false;
  const row = item as { role?: unknown; content?: unknown };
  return (row.role === "user" || row.role === "assistant") && typeof row.content === "string";
}

/**
 * 资料问答入口：独立于 /api/chat。
 *
 * 流程：inputGuard → toolGuard(searchDocs) → 检索判空 →（有命中）拼 RAG prompt
 *       → completeRagMessages → outputGuard
 * 响应：**SSE**（与 chat / multi 对齐过程可观测）：
 *   injection_detected? → tool_call / tool_result → output_leak_blocked?
 *   → rag_meta → delta(answer) → usage? → [DONE]
 *
 * Token：bindUsageCallback(acc, "rag"|"ragRewrite"|"ragHyde") → 各 LLM 层 parseUsage → record
 *        → writeUsageToStream
 *
 * 安全：
 * - Input：detectInjection(question) → 只标记；SSE injection_detected
 * - Tool：answerFromDocs 内 validateToolCall("searchDocs")；拒绝则 tool_result.error、不检索
 * - Output：detectLeakage → 可能换 safeText；SSE output_leak_blocked
 *
 * LangSmith（LANGCHAIN_TRACING_V2=true）：
 *   rag-request → rag-retrieve → rag-llm
 */
export function registerRagChatRoutes(app: Express): void {
  app.post("/api/rag/chat", async (req, res) => {
    setSseHeaders(res);

    // category（可选）：动态知识库分类，前端不选时缺省 → 全库搜（步骤 3 透传通道）
    const { question, history, model, userId, allowMemory, category } = req.body ?? {};
    if (typeof question !== "string" || !question.trim()) {
      res.write(`data: ${JSON.stringify({ error: "question 必须是非空字符串" })}\n\n`);
      res.end();
      return;
    }

    // system 由服务端 buildRagPrompt 固定注入，前端不能改
    const safeHistory: RagMessage[] = Array.isArray(history) ? history.filter(isRagHistoryItem) : [];
    const trimmedQuestion = question.trim();

    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    const writeSse = (event: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      const config = getRuntimeConfig();
      const defaultModel = typeof model === "string" && model ? model : config.model;

      // ---- Input Guard：只标记不拦截（与 chat / multi 一致）；通道改为 SSE ----
      const injection = detectInjection(trimmedQuestion);
      if (injection.level !== "none") {
        console.warn(
          `[InputGuard] rag level=${injection.level} rules=${injection.matchedRules.join(",")}`,
        );
        writeSse({
          type: "injection_detected",
          level: injection.level,
          rules: injection.matchedRules,
        });
      }

      // ---- Token：本请求一个累加器（先建好，Judge 拦截时也能写一份 0 用量）----
      const accumulator = new UsageAccumulator();
      const onUsage = bindUsageCallback(accumulator, "rag", defaultModel);
      const onRewriteUsage = bindUsageCallback(accumulator, "ragRewrite", defaultModel);
      const onHydeUsage = bindUsageCallback(accumulator, "ragHyde", defaultModel);

      // ---- LLM-as-Judge：默认 off 不调用 ----
      // - shadow：只写 judge_shadow 事件，主回答不变
      // - enforce：命中拦截策略时直接回安全文案，不检索也不调模型
      const judgeOutcome = await runInputJudge({
        text: trimmedQuestion,
        guard: { level: injection.level, rules: injection.matchedRules },
        emit: (event) => writeSse(event as unknown as Record<string, unknown>),
      });
      if (judgeOutcome.action === "block") {
        writeSse({ delta: judgeOutcome.safeText ?? SAFE_BLOCK_TEXT });
        writeUsageToStream(res, accumulator, "rag/chat", defaultModel);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const runAnswer = async () => {
        // ---- 长期记忆：路由层检索一次，检索片段**不进**记忆 ----
        // 放在 judge 之后：被拦截的输入不该触发任何记忆检索。
        // 关闭开关 / userId 非法时 retrieveMemoryBlock 直接返回 null（零检索）。
        const memoryOptions = {
          userId: isValidUserId(userId) ? userId : undefined,
          allowMemory: allowMemory === true,
          model: defaultModel,
          onTrace: (event: MemoryTraceEvent) => writeSse(event as unknown as Record<string, unknown>),
          onMemoryUsage: bindUsageCallback(accumulator, "memory", defaultModel),
        };
        const memoryBlock = await retrieveMemoryBlock(memoryOptions, trimmedQuestion);
        if (memoryBlock) {
          writeSse(
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

        const result = await answerFromDocs(
          trimmedQuestion,
          safeHistory,
          abortController.signal,
          defaultModel,
          onUsage,
          (event) => writeSse(event),
          // category 透传下去：问答也可以按分类硬过滤（步骤 4 合并时消费）
          { onRewriteUsage, onHydeUsage, memoryBlock, category },
        );

        // ---- 长期记忆抽取（旁路，不阻塞本轮回复）----
        // 抽取输入按统一口径裁剪：最近 2 轮**用户消息** + 本轮最终回答。
        // **检索到的资料片段一律不进抽取器**——那是产品资料，不是用户事实，
        // 混进去会把文档里的人名、配置记成用户偏好，越聊越脏。
        //
        // 只在「模型真的答了」时抽取：空结果返回的是固定文案、
        // 被 outputGuard 拦下时返回的是替换文案，两者都不是给用户的真实回答。
        if (result.calledModel && !result.outputLeakBlocked) {
          scheduleMemoryExtraction(
            memoryOptions,
            buildExtractionInput({
              messages: [...safeHistory, { role: "user", content: trimmedQuestion }],
              finalReply: result.answer,
            }),
            {
              apiKey: config.apiKey,
              forceMock: config.forceMock,
              baseUrl: config.baseUrl,
            },
          );
        }

        // 命中面板元数据（与 delta 分开，避免前端只靠拼字丢 hits）
        writeSse({
          type: "rag_meta",
          empty: result.empty,
          calledModel: result.calledModel,
          topScore: result.topScore,
          question: result.question,
          hits: result.hits,
          outputLeakBlocked: result.outputLeakBlocked,
          matchedFingerprints: result.matchedFingerprints,
          toolGuardBlocked: result.toolGuardBlocked,
          judgeBlocked: result.judgeBlocked,
          rewriteMeta: result.rewriteMeta,
          kbRouteMeta: result.kbRouteMeta,
          multiQueryMeta: result.multiQueryMeta,
          hydeMeta: result.hydeMeta,
        });
        // 整段答案一次推送（RAG complete 非流式；用 delta 复用前端气泡逻辑）
        writeSse({ delta: result.answer });
      };

      if (isLangSmithTracingEnabled()) {
        await traceRagRequest({
          run: runAnswer,
          userPreview: trimmedQuestion,
        });
      } else {
        await runAnswer();
      }

      // ---- Token：写 store + 推 usage（空累加则跳过）----
      writeUsageToStream(res, accumulator, "rag/chat", defaultModel);

      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error) {
      if (!res.writableEnded) {
        if (abortController.signal.aborted) {
          res.write(`data: ${JSON.stringify({ error: "已取消" })}\n\n`);
        } else {
          const message = error instanceof Error ? error.message : "未知错误";
          res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        }
        res.end();
      }
    }
  });
}
