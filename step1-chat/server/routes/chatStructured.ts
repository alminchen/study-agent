/**
 * 结构化输出 HTTP 路由。
 *
 * 本文件只负责把请求校验、模型/Mock 流、稳定快照、最终 schema、usage、trace
 * 和 SSE 终态串起来；JSON 语法解析和快照推进分别由 structured/ 下的模块负责。
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { renderMemoryText } from "../context/buildContext.js";
import { estimateMessageTokens } from "../context/tokenBudget.js";
import {
  buildExtractionInput,
  buildMemoryInjectedEvent,
  retrieveMemoryBlock,
  scheduleMemoryExtraction,
} from "../memory/bridge.js";
import { isValidUserId, type MemoryTraceEvent } from "../memory/types.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { streamStructuredCompletion } from "../structured/complete.js";
import { streamMockStructuredChunks } from "../structured/mockStream.js";
import {
  StructuredStreamAccumulator,
} from "../structured/streamAccumulator.js";
import {
  STRUCTURED_SCHEMA_VERSION,
  StructuredChatRequestSchema,
  type StructuredErrorCode,
  type StructuredSseEvent,
} from "../structured/types.js";
import {
  runStructuredCompletionWithTracing,
  runStructuredRequestWithTracing,
  type StructuredTraceOutcome,
} from "../tracing/langsmith.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

/** 把 accumulator 的最终校验码映射成客户端错误码；两者目前同名。 */
function mapFinishErrorCode(
  code: "invalid_final_json" | "schema_validation_failed",
): StructuredErrorCode {
  return code;
}

/**
 * 结构化输出入口。
 *
 * 负责 SSE 协议、最终校验、usage、trace、JSON mode 降级，以及客户端断连后
 * 终止上游请求并拒绝迟到 chunk。
 */
export function registerChatStructuredRoutes(app: Express): void {
  app.post("/api/chat/structured", async (req, res) => {
    // 请求体先过 Zod，避免后续模型请求、usage 和 trace 接收非法参数。
    const request = StructuredChatRequestSchema.safeParse(req.body);
    if (!request.success) {
      res.status(400).json({
        error: "结构化聊天请求参数不合法",
        issues: request.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }

    const config = getRuntimeConfig();
    const requestId = randomUUID();
    const startedAt = Date.now();
    setSseHeaders(res);

    // accumulator 负责文本累积/partial parse；abortController 负责上游模型取消。
    const accumulator = new StructuredStreamAccumulator();
    const abortController = new AbortController();
    // 客户端提前断开时同时中止模型请求和状态机，阻止后续 chunk 再生成快照。
    res.on("close", () => {
      if (!res.writableEnded) {
        abortController.abort();
        accumulator.abort();
      }
    });

    // 所有浏览器事件都经过此出口，统一阻止终态或已中止请求继续写数据。
    // 记忆事件（memory_injected / memory_extracted / memory_failed）与结构化事件同流，
    // 但不参与结构化协议本身：前端只在过程面板里展示，不进业务结果。
    const writeEvent = (event: StructuredSseEvent | MemoryTraceEvent) => {
      if (res.writableEnded || abortController.signal.aborted) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const usageAccumulator = new UsageAccumulator();
    const recordStructuredUsage = bindUsageCallback(
      usageAccumulator,
      "structured",
      request.data.model,
    );
    // 记忆抽取的 usage 单独记账（source = memory），与结构化主流的用量分开看。
    const recordMemoryUsage = bindUsageCallback(
      usageAccumulator,
      "memory",
      request.data.model,
    );
    let sequence = 0;
    let providerModel = request.data.model;
    let jsonModeFallback = false;
    let usageRecorded = false;

    // usage 最多写一次；空 usage、已结束或已中止请求不写日志/SSE。
    const flushUsage = () => {
      if (
        usageRecorded ||
        usageAccumulator.isEmpty ||
        res.writableEnded ||
        abortController.signal.aborted
      ) {
        return;
      }
      writeUsageToStream(
        res,
        usageAccumulator,
        "chat/structured",
        request.data.model,
      );
      usageRecorded = true;
    };

    /**
     * 接收模型文本片段并转换成两个协议事件：
     * structured_delta 只报告进度，structured_snapshot 才允许 UI 渲染。
     */
    const acceptChunk = (chunk: string) => {
      const appended = accumulator.append(chunk);
      if (!appended.accepted) {
        // 终态后的迟到 chunk 只记录诊断，不改变页面已经完成/中止的状态。
        console.warn("[chat/structured] rejected late chunk", {
          requestId,
          diagnostic: appended.diagnostic,
          ...accumulator.getStats(),
        });
        return;
      }

      // sequence 只描述接收顺序；UI 去重仍以 snapshot.revision 为准。
      sequence += 1;
      writeEvent({
        type: "structured_delta",
        sequence,
        receivedChars: accumulator.getStats().receivedChars,
      });

      if (appended.snapshot) {
        writeEvent({
          type: "structured_snapshot",
          revision: appended.snapshot.revision,
          snapshot: appended.snapshot,
        });
      }
    };

    // trace 只保留最后一条用户消息的短预览，不记录完整 prompt。
    const lastUser = [...request.data.messages]
      .reverse()
      .find((message) => message.role === "user");
    const traceMeta = {
      userPreview: lastUser?.content.trim() ?? "",
      model: request.data.model,
      target: request.data.target,
      messageCount: request.data.messages.length + 1,
      jsonModeRequested: !config.mockMode && config.structuredRequest.jsonMode,
    };

    /** 把当前 accumulator/trace 状态整理成根 span 的统一输出。 */
    const makeOutcome = (
      status: StructuredTraceOutcome["status"],
      extra: Partial<StructuredTraceOutcome> = {},
    ): StructuredTraceOutcome => ({
      status,
      model: providerModel,
      target: request.data.target,
      lastRevision: accumulator.getStats().revision,
      errorCode: null,
      validationCode: null,
      validationIssues: [],
      repairApplied: null,
      jsonModeFallback,
      usageRecorded,
      chunkCount: accumulator.getStats().chunkCount,
      rejectedChunkCount: accumulator.getStats().rejectedChunkCount,
      lastRejectedChunkDiagnostic:
        accumulator.getStats().lastRejectedChunkDiagnostic,
      ...extra,
    });

    const executeStructuredRequest = async (): Promise<StructuredTraceOutcome> => {
      // start 事件必须在 Mock/真实模型分支之前发出，前端据此建立结构化状态。
      writeEvent({
        type: "structured_start",
        requestId,
        schemaVersion: STRUCTURED_SCHEMA_VERSION,
      });

      try {
        // ---- 长期记忆：路由层检索一次，注入走 system prompt 末尾 ----
        // 关闭开关 / userId 非法时 retrieveMemoryBlock 直接返回 null（零检索）。
        // 检索的问题取「最后一条用户消息」：结构化链路没有别的自然语言入口。
        const lastUserMessage = [...request.data.messages]
          .reverse()
          .find((message) => message.role === "user");
        const memoryOptions = {
          userId: isValidUserId(request.data.userId)
            ? request.data.userId
            : undefined,
          allowMemory: request.data.allowMemory === true,
          model: request.data.model,
          onTrace: (event: MemoryTraceEvent) => writeEvent(event),
          onMemoryUsage: recordMemoryUsage,
        };
        const memoryBlock = await retrieveMemoryBlock(
          memoryOptions,
          lastUserMessage?.content ?? "",
        );
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

        if (config.mockMode) {
          // Mock 与真实模型共用 acceptChunk 和最终 schema，只替换文本来源。
          const streamResult = await streamMockStructuredChunks({
            target: request.data.target,
            signal: abortController.signal,
            onChunk: acceptChunk,
          });

          if (streamResult === "aborted" || abortController.signal.aborted) {
            accumulator.abort();
            console.info("chat/structured aborted by client", {
              requestId,
              mode: "mock",
              ...accumulator.getStats(),
            });
            return makeOutcome("aborted");
          }
          // Mock 没有 provider finish_reason，用固定值让最终统计仍可区分来源。
          accumulator.recordFinishReason("mock_completed");
        } else {
          // 每次模型尝试单独创建 LLM span；JSON mode 降级重试因此可被分别观察。
          const runCompletion = (jsonMode: boolean) =>
            runStructuredCompletionWithTracing(
              {
                model: request.data.model,
                target: request.data.target,
                messageCount: request.data.messages.length + 1,
                jsonMode,
              },
              () =>
                streamStructuredCompletion({
                  request: request.data,
                  apiKey: config.apiKey,
                  baseUrl: config.baseUrl,
                  signal: abortController.signal,
                  jsonMode,
                  includeUsage: config.structuredRequest.includeUsage,
                  timeouts: config.structuredRequest.timeouts,
                  // 记忆块只影响 system prompt 的内容取值，不影响 JSON 形状。
                  memoryBlock,
                  onChunk: acceptChunk,
                  onUsage: recordStructuredUsage,
                }),
            );

          // 第一轮按配置请求 JSON mode；失败后仅在明确不支持时降级一次。
          let completion = await runCompletion(
            config.structuredRequest.jsonMode,
          );
          if (
            completion.status === "failed" &&
            completion.error.code === "provider_json_mode_unsupported" &&
            config.structuredRequest.jsonMode
          ) {
            // 只允许一次 prompt-only 重试，避免能力不兼容时形成重试循环。
            jsonModeFallback = true;
            console.info(
              "[chat/structured] provider JSON mode unsupported; retrying prompt-only",
              { requestId },
            );
            completion = await runCompletion(false);
          }

          // provider 可能返回实际模型别名，trace 和 usage 都使用实际值。
          providerModel = completion.stats.model;
          accumulator.recordFinishReason(completion.stats.finishReason);

          // 用户停止优先保留最后快照，不发送结构化错误。
          if (completion.status === "aborted") {
            accumulator.abort();
            console.info("chat/structured aborted by client", {
              requestId,
              mode: "api",
              ...accumulator.getStats(),
            });
            return makeOutcome("aborted");
          }
          // provider 失败时先落已有 usage，再发送结构化错误并关闭 SSE。
          if (completion.status === "failed") {
            flushUsage();
            writeEvent({
              type: "structured_error",
              code: completion.error.code,
              message: completion.error.message,
              retryable: completion.error.retryable,
              lastRevision: accumulator.getStats().revision,
            });
            console.info("[chat/structured] provider failed", {
              requestId,
              mode: "api",
              durationMs: Date.now() - startedAt,
              errorCode: completion.error.code,
              jsonModeFallback,
              ...completion.stats,
            });
            if (!res.writableEnded) res.end();
            return makeOutcome("failed", {
              errorCode: completion.error.code,
            });
          }
        }

        // Mock/真实流结束后都必须走同一次完整 JSON + Zod 校验。
        const finished = accumulator.finish();
        const stats = accumulator.getStats();
        if (!finished.ok) {
          flushUsage();
          // 只有 JSON/schema 两类最终错误适合直接暴露给前端；其他状态机错误
          // 统一归为流中断，避免把内部终态诊断泄漏成公共协议。
          if (
            finished.code === "invalid_final_json" ||
            finished.code === "schema_validation_failed"
          ) {
            writeEvent({
              type: "structured_error",
              code: mapFinishErrorCode(finished.code),
              message: finished.message,
              retryable: finished.retryable,
              lastRevision: finished.revision,
            });
          }
          console.info("[chat/structured] validation failed", {
            requestId,
            mode: config.mockMode ? "mock" : "api",
            durationMs: Date.now() - startedAt,
            errorCode: finished.code,
            repairAttempted: finished.repairAttempted,
            issues: finished.issues,
            ...stats,
          });
          if (!res.writableEnded) res.end();
          return makeOutcome("failed", {
            errorCode:
              finished.code === "invalid_final_json" ||
              finished.code === "schema_validation_failed"
                ? finished.code
                : "model_stream_interrupted",
            validationCode: finished.code,
            validationIssues: finished.issues,
            repairApplied: finished.repairAttempted
              ? "stripped_json_fence_attempted"
              : null,
          });
        }

        // 最终 schema 通过后先落 usage，再发送 structured_done 和 [DONE]。
        flushUsage();
        writeEvent({
          type: "structured_done",
          revision: finished.revision,
          result: finished.result,
        });

        // ---- 长期记忆抽取（旁路，不阻塞本轮回复）----
        // 抽取输入按统一口径裁剪，但 structured 更窄：
        // **只用最后一条用户消息**，且**不带最终回答**——
        // 生成的 JSON / 表格是「数据」不是「用户事实」，
        // 把它当事实记下来，下一轮就会拿自己的输出反过来污染输入。
        scheduleMemoryExtraction(
          memoryOptions,
          buildExtractionInput({
            messages: lastUserMessage ? [lastUserMessage] : [],
            rounds: 1,
          }),
          {
            apiKey: config.apiKey,
            forceMock: config.forceMock,
            baseUrl: config.baseUrl,
          },
        );

        console.info("[chat/structured] completed", {
          requestId,
          mode: config.mockMode ? "mock" : "api",
          model: providerModel,
          durationMs: Date.now() - startedAt,
          repairApplied: finished.repairApplied,
          jsonModeFallback,
          finalTextLength: finished.finalTextLength,
          ...stats,
          hasUsage: usageRecorded,
        });
        if (!res.writableEnded) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        return makeOutcome("completed", {
          repairApplied: finished.repairApplied,
        });
      } catch (error) {
        // 如果 close listener 已触发，异常只是取消传播，不应当作服务端失败。
        if (abortController.signal.aborted) {
          accumulator.abort();
          console.info("chat/structured aborted by client", {
            requestId,
            mode: config.mockMode ? "mock" : "api",
            ...accumulator.getStats(),
          });
          return makeOutcome("aborted");
        }

        // 未分类异常统一收敛为可重试的模型流中断。
        const message = error instanceof Error ? error.message : "未知错误";
        flushUsage();
        writeEvent({
          type: "structured_error",
          code: "model_stream_interrupted",
          message,
          retryable: true,
          lastRevision: accumulator.getStats().revision,
        });
        if (!res.writableEnded) res.end();
        return makeOutcome("failed", {
          errorCode: "model_stream_interrupted",
        });
      }
    };

    // 根 span 包住完整请求；未启用 LangSmith 时该包装器直接执行原函数。
    try {
      await runStructuredRequestWithTracing(
        traceMeta,
        executeStructuredRequest,
      );
    } catch (error) {
      // tracing 包装层自身异常也要保证 SSE 有终止事件，避免浏览器永久等待。
      if (abortController.signal.aborted) return;
      const message = error instanceof Error ? error.message : "未知错误";
      writeEvent({
        type: "structured_error",
        code: "model_stream_interrupted",
        message,
        retryable: true,
        lastRevision: accumulator.getStats().revision,
      });
      if (!res.writableEnded) res.end();
    }
  });
}
