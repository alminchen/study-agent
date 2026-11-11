import type { Express } from "express";
import { createChatStream } from "../chat.js";
import { parseContextSummary } from "../context/parseContextSummary.js";
import { isValidUserId } from "../memory/types.js";
import { ConfirmSession } from "../react/confirmGate.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
import { isVisionCapableModel } from "../vision/capability.js";
import { estimateImageTokens } from "../vision/estimateImageTokens.js";
import { validateRequestMessages } from "../vision/validateRequestMessages.js";
import { setSseHeaders, writeUsageToStream } from "./sse.js";

/**
 * 单 Agent 聊天入口：SSE。
 *
 * 与 /api/chat/multi（多 Agent）并存。前端取消勾选「多 Agent」时走此端点。
 *
 * 服务端流程（见 server/chat.ts → runConversation）：
 *   createChatStream →（可选 prefetch searchDocs）→ LangGraph ReAct
 *   askModel ↔ applyTools → reply
 *
 * 人工确认（与 multi 共用 ConfirmSession + POST /api/chat/confirm）：
 *   - 本请求 new ConfirmSession()，挂给 createChatStream → applyToolCalls
 *   - 需确认工具：SSE pending_confirm → await wait → 前端 POST confirm → resolve
 *   - finally dispose，避免 wait 泄漏
 *
 * SSE 事件顺序（本 handler 写出 / onTrace 透传）：
 *   - tool_call / tool_result / pending_confirm / confirm_resolved 等 → 过程面板
 *   - injection_detected / output_leak_blocked / degradation…（防护相关）
 *   - context_compacted → 上下文压缩（本轮丢了多少轮、压前后各多少 token）
 *   - delta → 最终文字（流式）
 *   - usage → Token 合计
 *   - [DONE]
 *
 * 防护层：
 *   inputGuard / prefetch → chat.ts；toolCallGuard → applyToolCalls；outputGuard → reply
 */
export function registerChatRoutes(app: Express): void {
  app.post("/api/chat", async (req, res) => {
    // ---- 步骤 1：声明 SSE，后续按块写 data: 行 ----
    setSseHeaders(res);

    const { messages, model, searchDocs, contextSummary, userId, allowMemory } = req.body ?? {};

    // ---- 步骤 2：校验 messages ----
    if (!Array.isArray(messages)) {
      res.write(
        `data: ${JSON.stringify({ error: "messages 必须是非空数组" })}\n\n`,
      );
      res.end();
      return;
    }

    // ---- 步骤 2.1：图片附件二次校验（不信前端）----
    // 校验失败：不建 UsageAccumulator、不调模型，直接回 vision_rejected（省 token）。
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

    // ---- 步骤 3：用户断开连接时中止 ReAct 内 LLM / 确认 wait ----
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abortController.abort();
    });

    // ---- 步骤 4：本请求确认会话（构造时写入 sessions Map）----
    // 前端 pending_confirm.confirmId → POST /api/chat/confirm → getConfirmSession 取回同一实例
    const confirmSession = new ConfirmSession();

    try {
      const config = getRuntimeConfig();
      const defaultModel =
        typeof model === "string" && model ? model : config.model;

      // ---- 步骤 4.8：Vision 事件（有合法附件才推；无图完全静默）----
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
            (sum, a) =>
              sum + estimateImageTokens(a.width ?? 0, a.height ?? 0),
            0,
          ),
        };
        res.write(
          `data: ${JSON.stringify({
            type: "vision_attachment",
            count: attachments.length,
            mimeTypes: [
              ...new Set(attachments.map((a) => a.mimeType ?? "")),
            ],
            totalBytes: visionStats.totalBytes,
            estimatedImageTokens: visionStats.estimatedTokens,
          })}\n\n`,
        );
        if (!isVisionCapableModel(defaultModel)) {
          res.write(
            `data: ${JSON.stringify({
              type: "vision_unsupported_model",
              model: defaultModel,
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              error: `当前模型 ${defaultModel} 不支持图片输入`,
            })}\n\n`,
          );
          res.end();
          return;
        }
      }

      // ---- 步骤 5：Token 累加器 — askModel 每次 usage 打到同一 acc ----
      const accumulator = new UsageAccumulator();
      // ---- 步骤 9：图片成本进 usage（只记数字，不记 base64）----
      if (visionStats) {
        accumulator.recordImages(visionStats);
      }
      const onUsage = bindUsageCallback(accumulator, "askModel", defaultModel);
      // 摘要这次模型调用单独记一笔：要能看出「压缩花了多少」。
      const onSummaryUsage = bindUsageCallback(accumulator, "summary", defaultModel);
      // 记忆抽取同样单独记一笔：要能看出「记住这些花了多少」。
      const onMemoryUsage = bindUsageCallback(accumulator, "memory", defaultModel);

      // ---- 步骤 5.6：记忆开关 ----
      // userId 非法（不是 anon_xxx）就当没开记忆：不报错、不透传，
      // 聊天照常继续——记忆是可选能力，不能因为它坏了就让主链路失败。
      const memoryEnabled = allowMemory === true && isValidUserId(userId);

      // ---- 步骤 5.5：解析前端带回来的摘要 ----
      // 非法摘要当作没有摘要：不报错、不透传，聊天照常继续（决策四）。
      const parsedSummary = parseContextSummary(contextSummary);

      // ---- 步骤 6：进入单 Agent 聊天流（内部可能多次 onDelta / onTrace）----
      await createChatStream({
        messages,
        model: defaultModel,
        signal: abortController.signal,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        forceMock: config.forceMock,
        // 本链路启用按 token 预算分层保留（system → 摘要 → 近期原文）。
        contextMode: "budget",
        contextSummary: parsedSummary,
        // 跨会话记忆：注入相关记忆 + 抽取本轮的新事实
        userId: isValidUserId(userId) ? userId : undefined,
        allowMemory: memoryEnabled,
        // 勾选「搜索知识库」：服务端先强制检索，并把 searchDocs 工具交给模型
        searchDocs: searchDocs === true,
        confirmSession,
        onUsage,
        onSummaryUsage,
        onMemoryUsage,
        onDelta: (delta) => {
          console.log("delta :>> ", delta);
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        onTrace: (event) => {
          // 记忆抽取是 fire-and-forget：它的事件可能在流已经结束之后才到。
          // 这时不能再往已关闭的响应里写，否则会抛错。
          if (res.writableEnded) return;
          // 过程面板 + 确认闸门事件原样推给前端
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });

      // ---- 步骤 7：Token — 写 store + 推 usage ----
      writeUsageToStream(res, accumulator, "chat", defaultModel);

      // ---- 步骤 8：结束 SSE ----
      res.write("data: [DONE]\n\n");
      res.end();
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
