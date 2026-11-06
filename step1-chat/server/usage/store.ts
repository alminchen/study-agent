/**
 * Token 用量持久化与汇总查询。
 *
 * 存储策略（学习 demo 级）：
 *   - 内存数组 + JSON 文件双写（进程重启后从磁盘恢复）
 *   - 文件路径：data/usage-log.json（已加入 .gitignore）
 *   - 最多保留 500 条，超出截断最旧的
 *   - GET /api/usage 的 recent 只返回最新 50 条
 *
 * 生产环境应换 Redis / 时序库 / 计费系统，本模块不做那层。
 *
 * API 入口（server/index.ts）：
 *   appendUsageRecord()  — 每次 chat / multi / rag 请求结束时调用
 *   getUsageSummary()    — GET /api/usage
 *   clearUsageRecords()  — DELETE /api/usage（demo 清空）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UsageRecord, UsageScopeSummary, UsageSummary } from "./types.js";

const DATA_DIR = path.join(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "usage-log.json");

/** GET /api/usage 返回的 recent 数组最大条数 */
const MAX_RECENT = 50;

/** 磁盘文件最多保留条数，防止 JSON 无限膨胀 */
const MAX_RECORDS = 500;

/** 进程内缓存，启动时从磁盘加载 */
let records: UsageRecord[] = loadFromDisk();

/** 启动时读取 data/usage-log.json；文件不存在或解析失败返回空数组 */
function loadFromDisk(): UsageRecord[] {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const raw = readFileSync(LOG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as UsageRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 把当前 records 写回磁盘（自动创建 data/ 目录） */
function persist(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOG_FILE, JSON.stringify(records, null, 2), "utf-8");
}

/**
 * 追加一条请求级用量记录。
 * 由 server/index.ts 在 writeUsageToStream 或 RAG 响应前调用。
 */
export function appendUsageRecord(record: UsageRecord): void {
  records = [...records, record];
  if (records.length > MAX_RECORDS) {
    records = records.slice(-MAX_RECORDS);
  }
  persist();
}

/** 清空所有记录（DELETE /api/usage，学习 demo 用） */
export function clearUsageRecords(): void {
  records = [];
  persist();
}

/**
 * 本地时区当天 00:00 的时间戳；用于切出「当天」口径的记录集合。
 */
function startOfToday(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 把一组记录汇总成口径级统计。
 * 「全部」和「当天」共用这段逻辑，保证两个模块的口径完全一致。
 */
function summarize(scopeRecords: UsageRecord[]): UsageScopeSummary {
  const byEndpoint: UsageSummary["byEndpoint"] = {};
  const byModel: UsageSummary["byModel"] = {};

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;

  for (const r of scopeRecords) {
    totalPromptTokens += r.promptTokens;
    totalCompletionTokens += r.completionTokens;
    totalTokens += r.totalTokens;
    totalCostUsd += r.estimatedCostUsd;

    if (!byEndpoint[r.endpoint]) {
      byEndpoint[r.endpoint] = { requests: 0, totalTokens: 0, costUsd: 0 };
    }
    byEndpoint[r.endpoint].requests += 1;
    byEndpoint[r.endpoint].totalTokens += r.totalTokens;
    byEndpoint[r.endpoint].costUsd += r.estimatedCostUsd;

    if (!byModel[r.model]) {
      byModel[r.model] = { requests: 0, totalTokens: 0, costUsd: 0 };
    }
    byModel[r.model].requests += 1;
    byModel[r.model].totalTokens += r.totalTokens;
    byModel[r.model].costUsd += r.estimatedCostUsd;
  }

  return {
    totalRequests: scopeRecords.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCostUsd,
    byEndpoint,
    byModel,
  };
}

/**
 * 计算全局汇总：全部 + 当天两个口径，外加最近记录。
 * 供 GET /api/usage 和前端 UsagePanel 的两个统计模块使用。
 */
export function getUsageSummary(): UsageSummary {
  const all = summarize(records);
  const today = summarize(records.filter((r) => r.timestamp >= startOfToday(Date.now())));

  return {
    ...all,
    today,
    recent: [...records].reverse().slice(0, MAX_RECENT),
  };
}
