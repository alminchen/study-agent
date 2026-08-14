import express from "express";
import dotenv from "dotenv";
import { createChatStream } from "./chat.js";
import { answerFromDocs } from "./rag/answer.js";
import type { RagMessage } from "./rag/prompt.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

function getRuntimeConfig() {
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const forceMock = process.env.MOCK_MODE === "1";
  const mockMode = forceMock || !apiKey;
  return {
    apiKey,
    forceMock,
    mockMode,
    model: process.env.LLM_MODEL ?? "deepseek-chat",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1",
  };
}

app.get("/api/health", (_req, res) => {
  const config = getRuntimeConfig();
  res.json({
    ok: true,
    mode: config.mockMode ? "mock" : "api",
    hasApiKey: Boolean(config.apiKey),
    model: config.model,
    baseUrl: config.baseUrl,
  });
});

function isRagHistoryItem(item: unknown): item is RagMessage {
  if (!item || typeof item !== "object") return false;
  const row = item as { role?: unknown; content?: unknown };
  return (row.role === "user" || row.role === "assistant") && typeof row.content === "string";
}

/**
 * 资料问答入口：独立于 /api/chat。
 * 走检索 → 拼 RAG prompt → 调 LLM；不挂天气/时间工具，也不复用聊天那份 system。
 * 返回 JSON（不是 SSE）：空结果不调模型，有命中才一次拿完整回答。
 */
app.post("/api/rag/chat", async (req, res) => {
  const { question, history, model } = req.body ?? {};
  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "question 必须是非空字符串" });
    return;
  }

  // 只收 user/assistant 文本；system 由服务端 buildRagPrompt 固定注入，前端不能改。
  const safeHistory: RagMessage[] = Array.isArray(history) ? history.filter(isRagHistoryItem) : [];

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const result = await answerFromDocs(
      question.trim(),
      safeHistory,
      abortController.signal,
      typeof model === "string" && model ? model : undefined,
    );
    res.json(result);
  } catch (error) {
    if (abortController.signal.aborted) {
      res.status(499).json({ error: "已取消" });
      return;
    }
    const message = error instanceof Error ? error.message : "未知错误";
    res.status(500).json({ error: message });
  }
});

app.post("/api/chat", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const { messages, model } = req.body ?? {};
  if (!Array.isArray(messages)) {
    res.write(`data: ${JSON.stringify({ error: "messages 必须是非空数组" })}\n\n`);
    res.end();
    return;
  }

  const abortController = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const config = getRuntimeConfig();
    await createChatStream({
      messages,
      model: typeof model === "string" && model ? model : undefined,
      signal: abortController.signal,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      forceMock: config.forceMock,
      systemPrompt:
        "你是一个面向前端开发者的 AI 助手。请优先回答当前用户的问题，结合上下文，但不要复述全部历史；答案尽量简洁、准确、贴近实践。",
      maxContextMessages: 8,
      onDelta: (delta) => {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      },
      onTrace: (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    if (!res.writableEnded) {
      const message = error instanceof Error ? error.message : "未知错误";
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
});

app.listen(PORT, HOST, () => {
  const config = getRuntimeConfig();
  console.log(
    `API server ready at http://${HOST}:${PORT} (mode: ${config.mockMode ? "mock" : "api"}, hasApiKey: ${Boolean(config.apiKey)})`,
  );
  if (!config.apiKey) {
    console.warn("LLM_API_KEY not found. Loaded .env.local and .env, but API mode is unavailable.");
  }
});
