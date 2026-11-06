import type { Express } from "express";
import { clearUsageRecords, getUsageSummary } from "../usage/store.js";

/** GET/DELETE /api/usage — Token 汇总与清空（demo） */
export function registerUsageRoutes(app: Express): void {
  /** 全部 / 当天两个口径的 token 汇总、按 endpoint/model 分组、最近记录（UsagePanel 两个统计模块） */
  app.get("/api/usage", (_req, res) => {
    res.json(getUsageSummary());
  });

  /** 清空 data/usage-log.json（学习 demo 用，生产勿暴露） */
  app.delete("/api/usage", (_req, res) => {
    clearUsageRecords();
    res.json({ ok: true });
  });
}
