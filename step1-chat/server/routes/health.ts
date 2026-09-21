import type { Express } from "express";
import { getRuntimeConfig } from "../runtimeConfig.js";

/** GET /api/health — 前端探测 mock/api、模型名 */
export function registerHealthRoutes(app: Express): void {
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
}
