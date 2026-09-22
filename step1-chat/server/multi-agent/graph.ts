/**
 * 多 Agent LangGraph 图 — 将 Supervisor → Workers → Aggregate 编排为状态图。
 *
 * ┌───────┐     ┌──────────────────┐     ┌──────────────────┐     ┌───────────┐
 * │ START  │────►│ supervisorNode   │────►│ workersNode       │────►│ aggregateNode│──► END
 * └───────┘     └──────────────────┘     └──────────────────┘     └───────────┘
 *
 * 各节点职责：
 * - supervisorNode：调 supervisorRoute()，得到 RouteDecision，写入 state；中途 writeSse(supervisor_route)
 * - workersNode：根据 RouteDecision 并行执行对应 Worker，结果写入 state；中途 writeSse(worker_done)
 * - aggregateNode：调 aggregate()，把多个 Worker 结果汇总为最终回复
 *
 * 为什么不用条件边分出多个 Worker 节点？
 * - LangGraph JS 的并行支持有限，不如在一个 node 内用 Promise.all 并行
 * - 简化图结构：3 个节点线性串联，逻辑清晰
 * - Worker 数量动态（1~N 个），用条件边要枚举所有组合，不实际
 *
 * 与单 Agent 图（runConversation.ts）的对比：
 * - 单 Agent：askModel ←→ applyTools 循环 → reply（确认挂在 applyToolCalls）
 * - 多 Agent：supervisor → workers(内部各自循环) → aggregate（确认挂在 runToolSafely）
 * - 两者独立，通过不同 API 端点调用（/api/chat vs /api/chat/multi）
 *
 * 人工确认（请求级，不进 State）：
 * - chatMulti 创建 ConfirmSession + onTrace/writeSse，经本文件 options 下传给 Workers
 * - 必须在 graph.invoke **进行中**写 SSE；整图跑完再推则 wait 期间前端收不到 pending_confirm
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { ConfirmSession } from "../react/confirmGate.js";
import type { ToolTraceHandler } from "../react/types.js";
import {
  withMultiAggregateSpan,
  withMultiSupervisorSpan,
  withMultiWorkerSpan,
  withMultiWorkersSpan,
} from "../tracing/langsmith.js";
import { bindUsageCallback, type UsageAccumulator, type UsageSource } from "../usage/accumulator.js";
import { supervisorRoute } from "./supervisor.js";
import type { RouteDecision } from "./supervisor.js";
import { getWorkerFn } from "./workers/index.js";
import type { WorkerResult } from "./workers/types.js";
import { aggregate } from "./aggregate.js";

// ============================================================
// State 定义：图中各节点通过 state 传递数据
// ============================================================

/**
 * 多 Agent 图的状态结构。
 * 每个字段对应流程中的一个中间产物，由对应节点写入。
 */
const MultiAgentState = Annotation.Root({
  /** 用户原始消息（入口传入，全程只读） */
  userMessage: Annotation<string>,
  /** LLM API Key（入口传入，全程只读） */
  apiKey: Annotation<string>,
  /** LLM 接口地址（入口传入，全程只读） */
  baseUrl: Annotation<string | undefined>,
  /** 模型名（入口传入，全程只读） */
  model: Annotation<string | undefined>,
  /** 取消信号（入口传入，全程只读；用户断开 / wait 超时可 abort） */
  signal: Annotation<AbortSignal | undefined>,

  /** Supervisor 的路由决策（由 supervisorNode 写入） */
  routeDecision: Annotation<RouteDecision | null>,
  /** 所有 Worker 的执行结果（由 workersNode 写入） */
  workerResults: Annotation<WorkerResult[]>,
  /** 最终汇总回复（由 aggregateNode 写入） */
  finalOutput: Annotation<string | null>,
});

type MultiAgentStateType = typeof MultiAgentState.State;

/**
 * 图编译时的请求级注入（不进 LangGraph State）。
 * Session / onTrace / writeSse 由 chatMulti 闭包传入，供 Worker 中途推 SSE。
 */
export interface MultiAgentGraphOptions {
  /** 请求级 Token 累加器（可选） */
  accumulator?: UsageAccumulator;
  /** 默认模型名，用于 usage 记录 */
  defaultModel?: string;
  /** 人工确认；未传则需确认工具安全降级（回填「未启用确认通道」） */
  confirmSession?: ConfirmSession;
  /** 工具过程 / pending_confirm / confirm_resolved（invoke 进行中推 SSE） */
  onTrace?: ToolTraceHandler;
  /** multi 专有过程事件（supervisor_route / worker_done） */
  writeSse?: (payload: Record<string, unknown>) => void;
  /**
   * 前端勾选「搜索知识库」时为 true。
   * Supervisor 若未分到 kb，强制追加 kb Worker（task=用户原文），保证必走检索。
   */
  forceKbSearch?: boolean;
}

/**
 * 勾选搜索知识库时：路由结果里必须有 kb。
 * - 已有 kb → 不动（保留 Supervisor 拆好的子任务）
 * - 没有 kb → 追加 { name:"kb", task: 用户原文 }
 * - 若原先只有 general，追加 kb 后仍保留 general（闲聊补充）；Aggregate 会汇总
 */
function ensureKbWorker(decision: RouteDecision, userMessage: string): RouteDecision {
  if (decision.workers.some((w) => w.name === "kb")) {
    return decision;
  }
  return {
    workers: [...decision.workers, { name: "kb", task: userMessage }],
  };
}

// ============================================================
// 编译图
// ============================================================

/**
 * 编译多 Agent 状态图。
 *
 * 返回一个可 invoke 的 graph 实例。
 * 调用方传入初始 state（userMessage、apiKey 等），图自动按节点顺序执行。
 * 确认相关能力通过 options 注入，不写入 state。
 */
export function compileMultiAgentGraph(options?: MultiAgentGraphOptions) {
  const defaultModel = options?.defaultModel ?? process.env.LLM_MODEL ?? "deepseek-chat";
  const acc = options?.accumulator;
  const confirmSession = options?.confirmSession;
  const onTrace = options?.onTrace;
  const writeSse = options?.writeSse;
  const forceKbSearch = Boolean(options?.forceKbSearch);

  /** 无累加器时返回 undefined；有则按 source 打标签绑到同一个 acc */
  const onUsage = (source: UsageSource) =>
    acc ? bindUsageCallback(acc, source, defaultModel) : undefined;

  /**
   * 节点 1：Supervisor 路由。
   * 写出 supervisor_route，让前端在 Worker 跑完之前就能看到分发结果。
   * 勾选搜索知识库时：路由后 ensureKbWorker，保证 kb 一定进并行池。
   * LangSmith：multi-supervisor → multi-llm(role=supervisor)
   */
  async function supervisorNode(state: MultiAgentStateType) {
    return withMultiSupervisorSpan(async () => {
      console.log("\n=== [Multi-Agent] 1) Supervisor 路由 ===");
      let decision = await supervisorRoute({
        userMessage: state.userMessage,
        apiKey: state.apiKey,
        baseUrl: state.baseUrl,
        model: state.model,
        signal: state.signal,
        onUsage: onUsage("supervisor"),
      });

      if (forceKbSearch) {
        const before = decision.workers.map((w) => w.name).join(",");
        decision = ensureKbWorker(decision, state.userMessage);
        const after = decision.workers.map((w) => w.name).join(",");
        if (before !== after) {
          console.log(`  [forceKbSearch] 强制追加 kb：${before || "(空)"} → ${after}`);
        }
      }

      console.log(`  路由结果: ${decision.workers.map((w) => `${w.name}("${w.task}")`).join(", ")}`);
      writeSse?.({
        type: "supervisor_route",
        workers: decision.workers,
        forceKbSearch,
      });
      return { routeDecision: decision };
    });
  }

  /**
   * 节点 2：Worker 并行执行。
   * 把 confirmSession / onTrace 下传给每个 Worker；单个 Worker 完成后立刻 worker_done。
   * LangSmith：multi-workers → multi-worker(name) → multi-llm / tool
   */
  async function workersNode(state: MultiAgentStateType) {
    const decision = state.routeDecision;
    if (!decision || decision.workers.length === 0) {
      return { workerResults: [] };
    }

    const workerNames = decision.workers.map((w) => w.name);
    return withMultiWorkersSpan(workerNames, async () => {
      console.log(`\n=== [Multi-Agent] 2) 执行 Workers: ${workerNames.join(", ")} ===`);

      const promises = decision.workers.map(async (assignment) => {
        const fn = getWorkerFn(assignment.name);
        if (!fn) {
          const missing: WorkerResult = {
            worker: assignment.name,
            output: `Worker "${assignment.name}" 未注册`,
            toolsCalled: [],
            error: true,
          };
          writeSse?.({
            type: "worker_done",
            worker: missing.worker,
            toolsCalled: missing.toolsCalled,
            error: missing.error,
          });
          return missing;
        }

        console.log(`  [${assignment.name}] 开始执行: "${assignment.task}"`);
        const result = await withMultiWorkerSpan(assignment.name, assignment.task, () =>
          fn({
            task: assignment.task,
            apiKey: state.apiKey,
            baseUrl: state.baseUrl,
            model: state.model,
            signal: state.signal,
            onUsage: onUsage("worker"),
            confirmSession,
            onTrace,
          }),
        );
        console.log(`  [${assignment.name}] 完成: error=${result.error}, tools=${result.toolsCalled.join(",") || "无"}`);
        writeSse?.({
          type: "worker_done",
          worker: result.worker,
          toolsCalled: result.toolsCalled,
          error: result.error,
        });
        return result;
      });

      const results = await Promise.all(promises);
      return { workerResults: results };
    });
  }

  /**
   * 节点 3：Aggregate 汇总。
   * LangSmith：multi-aggregate → multi-llm(role=aggregate)（单 Worker 透传时可能无 LLM）
   */
  async function aggregateNode(state: MultiAgentStateType) {
    return withMultiAggregateSpan(state.workerResults.length, async () => {
      console.log("\n=== [Multi-Agent] 3) Aggregate 汇总 ===");
      const output = await aggregate({
        results: state.workerResults,
        userMessage: state.userMessage,
        apiKey: state.apiKey,
        baseUrl: state.baseUrl,
        model: state.model,
        signal: state.signal,
        onUsage: onUsage("aggregate"),
      });
      console.log(`  最终回复长度: ${output.length} 字`);
      return { finalOutput: output };
    });
  }

  const graph = new StateGraph(MultiAgentState)

    // ---- addNode：注册图中的节点（每个节点是一个异步函数，接收 state、返回 state 片段）----
    // "supervisor" 节点：调用 supervisorRoute()，把用户意图分类为路由决策
    .addNode("supervisor", supervisorNode)
    // "workers" 节点：根据路由决策并行执行对应的 Worker（realtime/kb/action/general）
    .addNode("workers", workersNode)
    // "aggregate" 节点：把多个 Worker 结果汇总为一段连贯回复
    .addNode("aggregate", aggregateNode)

    // ---- addEdge：声明节点之间的连线（执行顺序）----
    // addEdge(A, B) 表示"A 节点执行完后，自动进入 B 节点"
    // START 是 LangGraph 内置的起点常量，END 是内置的终点常量
    .addEdge(START, "supervisor") // 图启动 → 先跑 Supervisor 路由
    .addEdge("supervisor", "workers") // 路由完成 → 执行 Workers
    .addEdge("workers", "aggregate") // Workers 全部完成 → 汇总
    .addEdge("aggregate", END); // 汇总完成 → 图结束，返回最终 state

  return graph.compile();
}
