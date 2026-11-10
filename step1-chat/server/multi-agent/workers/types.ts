/**
 * Worker 通用类型定义。
 *
 * 在多 Agent 架构中，每个 Worker 是一个独立的"迷你 Agent"：
 * - 有自己专属的 system prompt（描述自己的能力边界）
 * - 有自己的工具列表（只能看到自己负责的工具）
 * - 有自己的 ReAct 循环（独立于主对话）
 *
 * Worker 执行完后统一返回 WorkerResult，交给 Aggregate 节点汇总。
 *
 * 数据流位置：
 *   Supervisor → WorkerContext(task) → Worker 执行 → WorkerResult → Aggregate
 */

import type { ContextMemoryBlock } from "../../context/types.js";

/**
 * Worker 执行结果。
 * 无论成功还是失败，都用这个结构返回给 Supervisor/Aggregate。
 */
export interface WorkerResult {
  /** 产出此结果的 Worker 名称（用于 Aggregate 区分来源） */
  worker: string;

  /**
   * Worker 的最终回复文本。
   * - 成功时：模型基于工具结果组织的自然语言回答
   * - 失败时：错误描述（如"实时查询服务暂时不可用"）
   */
  output: string;

  /**
   * Worker 过程中实际调用了哪些工具（按调用顺序）。
   * 用途：调试 + trace event 展示 + Evals 验证。
   * 示例：["getWeather", "getCurrentTime"]
   */
  toolsCalled: string[];

  /**
   * 是否执行出错。
   * true = Worker 未能正常完成任务（网络失败、模型无响应、超过最大轮次等）
   * Aggregate 汇总时可据此决定是否在回复中标注"部分信息获取失败"
   */
  error: boolean;
}

/**
 * Worker 执行所需的公共参数。
 * 由 graph 节点从全局 state 中提取，传给具体的 Worker 函数。
 */
export interface WorkerContext {
  /**
   * Supervisor 分配给此 Worker 的子任务描述。
   * 这不是用户原文，而是 Supervisor 从用户原文中提取的、属于此 Worker 职责范围的部分。
   * 示例：用户说"广州天气怎么样？顺便看看笔记" → realtime Worker 收到 task="广州天气"
   */
  task: string;

  /** LLM API Key（从主流程透传） */
  apiKey: string;

  /** LLM 接口地址（从主流程透传），默认 DeepSeek */
  baseUrl?: string;

  /** 模型名（从主流程透传），默认 deepseek-chat */
  model?: string;

  /** 取消信号（用户断开连接时中止 Worker 的 LLM 调用） */
  signal?: AbortSignal;

  /** Token 统计回调（每次 callLLM 拿到 usage 时触发） */
  onUsage?: (usage: import("../../usage/types.js").TokenUsage, model: string) => void;

  /** 人工确认会话（由 /api/chat/multi 创建并下传） */
  confirmSession?: import("../../react/confirmGate.js").ConfirmSession;

  /** SSE 过程事件（pending_confirm 等，invoke 进行中写出） */
  onTrace?: import("../../react/types.js").ToolTraceHandler;

  /**
   * 本轮检索出的长期记忆块。
   *
 * 由路由层（chatMulti）检索**一次**，再通过 graph options 下传给每个 Worker：
   * 四个 Worker 各检索一次 = 四倍向量计算 + 四份可能不一致的注入。
   * 未传 / 为空 = 本轮没有记忆，Worker 的消息列表与接入记忆前完全一致。
   */
  memoryBlock?: ContextMemoryBlock;
}
