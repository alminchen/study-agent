/**
 * 人工确认闸门（ConfirmSession）
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 解决什么问题                                                     │
 * │ 有后果的工具不能在模型一返回 tool_calls 就立刻 run。               │
 * │ 必须先通知前端「待确认」，等人点允许/拒绝后再决定是否执行。         │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 时序（对接聊天后）：
 *
 *   applyToolCalls                 浏览器                    POST /api/chat/confirm
 *        │                            │                              │
 *        │  onTrace(pending_confirm)  │                              │
 *        │ ──────────────────────────►│ 展示参数 + 允许/拒绝           │
 *        │  await wait(toolCallId)    │                              │
 *        │         （卡住）            │  用户点击                     │
 *        │                            │─────────────────────────────►│
 *        │◄─────────────────────────── resolve(allow|deny) ──────────│
 *        │  继续 run 或回填拒绝        │                              │
 *
 * 关键约定：
 * - 一次 HTTP 聊天请求 ↔ 一个 ConfirmSession（confirmId）
 * - 一轮里每个需确认的 tool_call 用自己的 toolCallId 做 wait/resolve 键
 * - 请求结束必须 dispose()，否则 Promise 会一直挂着占内存
 *
 * 谁创建 Session？
 * - `routes/chat.ts` 的 POST /api/chat：`const confirmSession = new ConfirmSession()`
 * - 构造函数里 `sessions.set(this.confirmId, this)`，所以后面 confirm 路由才能 get
 * - 同一请求把 session 传给 createChatStream → runConversation → applyToolCalls
 * - 前端从 SSE pending_confirm.confirmId 拿到 id，再 POST /api/chat/confirm
 * - 请求结束 finally：`confirmSession.dispose()` 从 Map 删掉
 *
 * getConfirmSession 不是凭空造对象，只是按 id 查「聊天请求已经 new 出来并登记过的」那份。
 */

import { randomUUID } from "node:crypto";

/** 用户对单次工具调用的决定 */
export type ConfirmAction = "allow" | "deny";

/**
 * 某个 toolCallId 正在等人的挂起项。
 * resolve/reject 来自 wait() 里 new Promise 的回调。
 */
interface PendingEntry {
  /** 工具名，仅供调试 / GET pending 列表展示 */
  name: string;
  /** 已解析的参数对象（或原始字符串），给前端审阅 */
  arguments: unknown;
  resolve: (action: ConfirmAction) => void;
  reject: (error: Error) => void;
}

/**
 * 进程内注册表：confirmId → Session。
 * confirm 路由用 getConfirmSession 查找；聊天创建 Session 时自动登记。
 * 注意：多进程 / 多机部署时内存 Map 不共享，学习 demo 单进程够用。
 */
const sessions = new Map<string, ConfirmSession>();

/**
 * 一次聊天请求对应的确认会话。
 *
 * 生命周期：
 * 1. new ConfirmSession() → 写入 sessions
 * 2. applyToolCalls 对需确认工具 await wait(...)
 * 3. 前端 POST confirm → resolve(toolCallId, action)
 * 4. 请求结束 / 断开 → dispose()（未决项按 deny 解开，避免死等）
 */
export class ConfirmSession {
  /** 给前端和 confirm API 用的会话 id（默认 UUID） */
  readonly confirmId: string;

  /** toolCallId → 正在 wait 的 Promise 回调 */
  private readonly pending = new Map<string, PendingEntry>();

  /** dispose 后禁止再 wait；重复 dispose 是空操作 */
  private disposed = false;

  constructor(confirmId: string = randomUUID()) {
    this.confirmId = confirmId;
    // 登记到模块级 Map，供另一条 HTTP（/api/chat/confirm）用同一 id 找回本实例
    sessions.set(this.confirmId, this);
  }

  /**
   * 阻塞直到该 toolCallId 被 allow/deny，或 signal abort / dispose。
   *
   * @param toolCallId 模型返回的 tool_calls[].id，必须与 confirm 请求一致
   * @param name 工具名（写入 pending，方便 GET 调试）
   * @param args 展示给用户看的参数
   * @param signal 聊天请求的 AbortSignal；用户点停止时应 reject，解除 await
   */
  wait(
    toolCallId: string,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ConfirmAction> {
    if (this.disposed) {
      return Promise.reject(new Error("确认会话已结束"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("请求已取消"));
    }

    return new Promise<ConfirmAction>((resolve, reject) => {
      // 用户断开 SSE / 点停止 → 不能继续占着 applyToolCalls
      const onAbort = () => {
        this.pending.delete(toolCallId);
        reject(new Error("请求已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(toolCallId, {
        name,
        arguments: args,
        resolve: (action) => {
          signal?.removeEventListener("abort", onAbort);
          this.pending.delete(toolCallId);
          resolve(action);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          this.pending.delete(toolCallId);
          reject(error);
        },
      });
    });
  }

  /**
   * 前端确认结果入口。
   * @returns false = 没有对应 pending（id 错了、已超时、或已经 resolve 过）
   */
  resolve(toolCallId: string, action: ConfirmAction): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    entry.resolve(action);
    return true;
  }

  /** 调试用：当前还卡在等确认的工具列表 */
  listPending(): Array<{ toolCallId: string; name: string; arguments: unknown }> {
    return [...this.pending.entries()].map(([toolCallId, entry]) => ({
      toolCallId,
      name: entry.name,
      arguments: entry.arguments,
    }));
  }

  /**
   * 请求收尾：把未决确认一律当成 deny，唤醒仍在 await 的 applyToolCalls，
   * 再从全局 sessions 注销，防止泄漏。
   *
   * 为何用 deny 而不是 reject？
   * - reject 会变成「确认等待失败」类错误
   * - deny 与「用户拒绝」同路径，模型收到明确的 { error: 用户拒绝… }，行为更一致
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, entry] of this.pending) {
      entry.resolve("deny");
    }
    this.pending.clear();
    sessions.delete(this.confirmId);
  }
}

/** 按 confirmId 取回「聊天请求里已经 new ConfirmSession() 并登记」的实例；没有则 undefined */
export function getConfirmSession(confirmId: string): ConfirmSession | undefined {
  return sessions.get(confirmId);
}
