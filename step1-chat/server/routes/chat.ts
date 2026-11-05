import type { Express } from "express";
import { createChatStream } from "../chat.js";
import { parseContextSummary } from "../context/parseContextSummary.js";
import { ConfirmSession } from "../react/confirmGate.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { UsageAccumulator, bindUsageCallback } from "../usage/accumulator.js";
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

    const { messages, model, searchDocs, contextSummary } = req.body ?? {};

    // ---- 步骤 2：校验 messages ----
    if (!Array.isArray(messages)) {
      res.write(
        `data: ${JSON.stringify({ error: "messages 必须是非空数组" })}\n\n`,
      );
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

      // ---- 步骤 5：Token 累加器 — askModel 每次 usage 打到同一 acc ----
      const accumulator = new UsageAccumulator();
      const onUsage = bindUsageCallback(accumulator, "askModel", defaultModel);
      // 摘要这次模型调用单独记一笔：要能看出「压缩花了多少」。
      const onSummaryUsage = bindUsageCallback(accumulator, "summary", defaultModel);

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
        // 勾选「搜索知识库」：服务端先强制检索，并把 searchDocs 工具交给模型
        searchDocs: searchDocs === true,
        confirmSession,
        onUsage,
        onSummaryUsage,
        onDelta: (delta) => {
          console.log("delta :>> ", delta);
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        onTrace: (event) => {
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
