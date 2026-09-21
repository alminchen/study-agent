/**
 * Supervisor（路由层）
 *
 * 多 Agent 编排的第一个环节：接收用户问题，用一次 LLM 调用判断应分发给哪些 Worker。
 *
 * 整体流程：
 *   用户消息 → supervisorRoute() → RouteDecision → graph 条件边分发
 *
 * 路由策略：
 * - 通过 system prompt 引导模型调用 `route` 工具，确保输出结构化 JSON
 * - 模型根据 SUPERVISOR_SYSTEM_PROMPT 中描述的 Worker 能力来决定分发
 * - 一句话可能同时需要多个 Worker（如「查天气顺便看看笔记」→ realtime + kb）
 * - 不认识的意图兜底到 GeneralWorker（纯聊天，无工具）
 *
 * 兜底策略（多层保护）：
 * - LLM 调用本身失败（网络/鉴权）→ 兜底 general
 * - 模型没调 route 工具 → 兜底 general
 * - route 工具参数 JSON 解析失败 → 兜底 general
 * - 返回的 worker name 不在白名单 → 过滤掉，全空则兜底 general
 */

import { callLLM } from "./llm.js";

/** 可用的 Worker 类型：realtime / kb / action(有后果确认) / general */
export type WorkerName = "realtime" | "kb" | "action" | "general";

/** Supervisor 的路由决策结果，包含需要调度的 Worker 列表及各自的子任务 */
export interface RouteDecision {
  workers: { name: WorkerName; task: string }[];
}

/**
 * Supervisor 专用 system prompt。
 * 关键设计：
 * - 只描述每个 Worker 的能力边界和关键词，让模型做意图分类
 * - 明确规则：可多选、不确定选 general、必须调 route 工具
 * - 不包含任何业务回答逻辑，Supervisor 只做"分发"不做"回答"
 */
const SUPERVISOR_SYSTEM_PROMPT =
  "你是一个任务路由器。根据用户问题判断需要调度哪些 Worker。\n" +
  "可用 Worker：\n" +
  "- realtime：处理需要实时数据的问题——天气、气温、当前时间、日期。关键词：天气、温度、几点、时间、今天几号。\n" +
  "- kb：处理知识库/笔记/资料搜索问题。关键词：笔记、资料、文档、搜索知识库。\n" +
  "- action：处理起草/发送消息等有后果的动作。关键词：起草、发送、发给、通知、写一条消息。\n" +
  "- general：兜底，处理闲聊或以上 Worker 都不匹配的问题。\n\n" +
  "规则：\n" +
  "1. 一句话可能同时需要多个 Worker（如「查天气顺便看看笔记」→ realtime + kb）\n" +
  "2. 如果不确定归谁，选 general\n" +
  "3. 起草/发送类必须选 action，不要交给 general\n" +
  "4. 必须调用 route 工具返回结果，不要直接回复用户";

/**
 * route 工具的 Function Calling schema。
 * 这个工具不是真正要"执行"的——它只是让模型以结构化 JSON 输出路由决策。
 *
 * 输出格式：{ workers: [{ name: "realtime"|"kb"|"general", task: "子任务描述" }] }
 */
const ROUTE_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "route",
    description: "输出路由决策：选择需要的 Worker 及各自的子任务描述",
    parameters: {
      type: "object",
      properties: {
        workers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                enum: ["realtime", "kb", "action", "general"],
                description: "Worker 名称",
              },
              task: {
                type: "string",
                description: "分配给该 Worker 的具体子任务描述",
              },
            },
            required: ["name", "task"],
          },
          description: "需要调度的 Worker 列表",
        },
      },
      required: ["workers"],
    },
  },
};

/** supervisorRoute 的入参 */
interface SupervisorOptions {
  /** 用户本轮的原始消息文本 */
  userMessage: string;
  /** LLM API Key */
  apiKey: string;
  /** LLM 接口地址，默认 DeepSeek */
  baseUrl?: string;
  /** 模型名，默认 deepseek-chat */
  model?: string;
  /** 用于取消请求的 AbortSignal */
  signal?: AbortSignal;
  /** Token 统计回调 */
  onUsage?: (usage: import("../usage/types.js").TokenUsage, model: string) => void;
}

/**
 * Supervisor 路由主函数。
 *
 * 做一次 LLM 调用（非流式），让模型通过 route 工具输出路由决策。
 * 整个过程只消耗一次短对话的 token（system + 一句 user），成本很低。
 *
 * @returns RouteDecision — 后续 graph 根据这个结果走条件边分发给对应 Worker
 *
 * 示例返回：
 *   输入: "广州天气怎么样？顺便搜搜笔记里的出行建议"
 *   输出: { workers: [{ name:"realtime", task:"广州天气" }, { name:"kb", task:"出行建议" }] }
 *
 *   输入: "你好"
 *   输出: { workers: [{ name:"general", task:"你好" }] }
 */
export async function supervisorRoute(options: SupervisorOptions): Promise<RouteDecision> {
  // 使用公共 callLLM 方法，不再手写 fetch
  const result = await callLLM({
    messages: [
      { role: "system", content: SUPERVISOR_SYSTEM_PROMPT },
      { role: "user", content: options.userMessage },
    ],
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    // 用 auto 而非强制指定：DeepSeek thinking 模式不支持 tool_choice 指定函数名。
    // system prompt 里已明确要求"必须调用 route 工具"，兜底逻辑覆盖模型不调的情况。
    tools: [ROUTE_TOOL_SCHEMA],
    toolChoice: "auto",
    signal: options.signal,
    onUsage: options.onUsage,
  });

  // 兜底 1：LLM 调用失败
  if (!result.ok) {
    console.warn(`[Supervisor] LLM 路由调用失败 (${result.status})，兜底 general`);
    return fallback(options.userMessage);
  }

  // 兜底 2：模型没返回 tool_calls
  if (result.toolCalls.length === 0) {
    console.warn("[Supervisor] 模型未调用 route 工具，兜底 general");
    return fallback(options.userMessage);
  }

  // 解析 route 工具的 arguments JSON
  try {
    const parsed = JSON.parse(result.toolCalls[0].function.arguments) as { workers: { name: string; task: string }[] };

    // 兜底 3：过滤掉不在白名单中的 worker name（防止模型幻觉）
    const valid = parsed.workers.filter(
      (w) =>
        w.name === "realtime" ||
        w.name === "kb" ||
        w.name === "action" ||
        w.name === "general",
    ) as RouteDecision["workers"];

    // 兜底 4：过滤后为空
    if (valid.length === 0) {
      return fallback(options.userMessage);
    }
    return { workers: valid };
  } catch {
    // 兜底 5：JSON 解析失败（模型输出了非法 JSON）
    console.warn("[Supervisor] route 参数解析失败，兜底 general");
    return fallback(options.userMessage);
  }
}

/** 兜底函数：任何异常情况都走 GeneralWorker，把用户原文当作 task */
function fallback(task: string): RouteDecision {
  return { workers: [{ name: "general", task }] };
}
