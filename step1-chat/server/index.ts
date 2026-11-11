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
import { warmRagModels } from "./rag/warmup.js";

// 先 .env.local（本机密钥）再 .env（可提交的默认项）；后者不覆盖前者已有值
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const app = express();

// JSON 解析：默认 1mb；/api/chat 系列单独放宽到 8mb，
// 给「图片 base64 撑大的请求体」留空间，其余端点不上调、不放大攻击面（决策三）。
const parseJsonDefault = express.json({ limit: "1mb" });
const parseJsonChat = express.json({ limit: "8mb" });
app.use((req, res, next) => {
  const isChatFamily =
    req.path === "/api/chat" || req.path.startsWith("/api/chat/");
  (isChatFamily ? parseJsonChat : parseJsonDefault)(req, res, next);
});

const PORT = Number(process.env.PORT ?? 18787);
const HOST = process.env.HOST ?? "127.0.0.1";

registerRoutes(app);

// 413 兜底：明确文案，不出现裸 500（失败路径清单「请求体超限」）。
app.use(
  (
    err: { type?: string; status?: number } & Error,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      res
        .status(413)
        .json({ error: "请求体超过大小限制", code: "vision_payload_too_large" });
      return;
    }
    next(err);
  },
);

app.listen(PORT, HOST, () => {
  const config = getRuntimeConfig();
  console.log(
    `API server ready at http://${HOST}:${PORT} (mode: ${config.mockMode ? "mock" : "api"}, hasApiKey: ${Boolean(config.apiKey)})`,
  );
  if (!config.apiKey) {
    console.warn("LLM_API_KEY not found. Loaded .env.local and .env, but API mode is unavailable.");
  }
  // 不阻塞端口：后台加载本地 ONNX，消灭首次检索冷启动
  void warmRagModels();
});
