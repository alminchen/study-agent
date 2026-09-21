/**
 * Worker 注册表。
 *
 * 作用：根据 Supervisor 路由返回的 WorkerName，找到对应的执行函数。
 *
 * 数据流位置：
 *   Supervisor 返回 RouteDecision
 *     → graph 取出每个 worker 的 name
 *     → 调用 getWorkerFn(name) 获取执行函数
 *     → 执行函数(ctx) → WorkerResult
 *
 * 扩展方式：
 * 新增 Worker 只需两步：
 *   1. 在 workers/ 下写一个 xxxWorker.ts（导出 runXxxWorker 函数）
 *   2. 在 WORKER_REGISTRY 里注册 name → 函数 的映射
 */

import type { WorkerName } from "../supervisor.js";
import type { WorkerContext, WorkerResult } from "./types.js";
import { runRealtimeWorker } from "./realtimeWorker.js";
import { runKBWorker } from "./kbWorker.js";
import { runActionWorker } from "./actionWorker.js";
import { runGeneralWorker } from "./generalWorker.js";

export type { WorkerContext, WorkerResult } from "./types.js";

/** Worker 执行函数的统一签名：接收上下文，返回结果 */
type WorkerFn = (ctx: WorkerContext) => Promise<WorkerResult>;

/**
 * Worker 注册表：name → 执行函数。
 * graph 节点通过这个映射动态调度 Worker。
 */
const WORKER_REGISTRY: Record<WorkerName, WorkerFn> = {
  realtime: runRealtimeWorker,
  kb: runKBWorker,
  action: runActionWorker,
  general: runGeneralWorker,
};

/**
 * 根据 Worker 名称获取执行函数。
 *
 * @param name Supervisor 路由结果中的 worker name
 * @returns 对应的执行函数，找不到返回 undefined
 *
 * 正常情况下不会返回 undefined，因为 Supervisor 已做白名单过滤。
 * 但防御性编程：调用方应检查返回值。
 */
export function getWorkerFn(name: WorkerName): WorkerFn | undefined {
  return WORKER_REGISTRY[name];
}
