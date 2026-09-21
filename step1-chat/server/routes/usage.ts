import type { Express } from "express";
import { clearUsageRecords, getUsageSummary } from "../usage/store.js";

/** GET/DELETE /api/usage — Token 汇总与清空（demo） */
export function registerUsageRoutes(app: Express): void {
  /** 累计 token、按 endpoint/model 分组、最近记录（UsagePanel「累计」） */
  app.get("/api/usage", (_req, res) => {
    res.json(getUsageSummary());
  });

  /** 清空 data/usage-log.json（学习 demo 用，生产勿暴露） */
  app.delete("/api/usage", (_req, res) => {
    clearUsageRecords();
    res.json({ ok: true });
  });
}
