import type { Express } from "express";
import { detectInjection } from "../guard/inputGuard.js";
import { SAFE_BLOCK_TEXT } from "../guard/judgePolicy.js";
import { runInputJudge } from "../guard/judgeRuntime.js";
import { compileMultiAgentGraph } from "../multi-agent/graph.js";
import { ConfirmSession } from "../react/confirmGate.js";
import type { ToolTraceHandler } from "../react/types.js";
import { getRuntimeConfig } from "../runtimeConfig.js";
import { runMultiRequestWithTracing } from "../tracing/langsmith.js";
import { UsageAccumulator } from "../usage/accumulator.js";
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
 *   1. supervisor_route  — 路由到了哪些 Worker（invoke 中途）
 *   2.（若需确认）tool_call → pending_confirm → confirm_resolved → tool_result
 *   3. worker_done × N   — 每个 Worker 调了哪些工具（invoke 中途）
 *   4. delta             — Aggregate 后的最终回复（整段，非流式逐字；已过 outputGuard）
 *   5. usage             — Supervisor+Worker+Aggregate token 合计
 *   6. [DONE]
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

    const { messages, model, searchDocs } = req.body ?? {};

    // ---- 步骤 1：校验 messages（至少一条，含 user 角色）----
    if (!Array.isArray(messages) || messages.length === 0) {
      res.write(`data: ${JSON.stringify({ error: "messages 必须是非空数组" })}\n\n`);
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
