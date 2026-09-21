/**
 * Express API 入口（step1-chat 后端）。
 *
 * 本文件只做「接线」：读环境变量、挂路由、启动监听。
 * 路由实现见 server/routes/：
 *   - routes/usage.ts      GET/DELETE /api/usage
 *   - routes/health.ts     GET /api/health
 *   - routes/ragChat.ts    POST /api/rag/chat   （JSON）
 *   - routes/chat.ts       POST /api/chat       （单 Agent SSE）
 *   - routes/chatMulti.ts  POST /api/chat/multi （多 Agent SSE）
 *
 * 更深业务：
 *   - 单 Agent ReAct  → chat.ts → react/runConversation.ts
 *   - 多 Agent        → multi-agent/graph.ts
 *   - 资料问答 RAG    → rag/answer.ts
 *   - Token 统计      → usage/*
 *
 * 流程图：diagrams/usage-token.svg · docs/project-messages-flow.md
 * 启动：npm run dev:server（tsx watch server/index.ts）
 */

import express from "express";
import dotenv from "dotenv";
import { getRuntimeConfig } from "./runtimeConfig.js";
import { registerRoutes } from "./routes/index.js";

// 先 .env.local（本机密钥）再 .env（可提交的默认项）；后者不覆盖前者已有值
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

registerRoutes(app);

app.listen(PORT, HOST, () => {
  const config = getRuntimeConfig();
  console.log(
    `API server ready at http://${HOST}:${PORT} (mode: ${config.mockMode ? "mock" : "api"}, hasApiKey: ${Boolean(config.apiKey)})`,
  );
  if (!config.apiKey) {
    console.warn("LLM_API_KEY not found. Loaded .env.local and .env, but API mode is unavailable.");
  }
});
