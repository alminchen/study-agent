/**
 * 人工确认 HTTP 接口。
 *
 * 与 SSE 聊天是两条线：
 * - 聊天长连接：单 Agent 在 applyToolCalls、多 Agent 在 runToolSafely 里 await ConfirmSession.wait（卡住）
 * - 本文件：前端点按钮后打一枪 JSON，把 wait 解开
 *
 * 会话由 /api/chat 或 /api/chat/multi 创建并登记；本路由只 get + resolve，不 new Session。

 * 聊天 UI 未对接前：
 * - POST 在没有人 wait 时会 404（没有 pending）——属预期
 * - GET 可查看某 confirmId 下还卡着哪些 toolCallId，方便联调
 *
 * Body（POST）：
 *   { confirmId: string, toolCallId: string, action: "allow" | "deny" }
 */

import type { Express } from "express";
import { getConfirmSession, type ConfirmAction } from "../react/confirmGate.js";

function isConfirmAction(value: unknown): value is ConfirmAction {
  return value === "allow" || value === "deny";
}

/** 挂载确认相关路由；由 routes/index registerRoutes 调用 */
export function registerChatConfirmRoutes(app: Express): void {
  /**
   * 放行或拒绝某次工具调用。
   * 成功只表示「解开了 wait」；真正 run 发生在：
   * - 单 Agent：applyToolCalls 里 allow 之后
   * - 多 Agent：runToolSafely 里 allow 之后
   */
  app.post("/api/chat/confirm", (req, res) => {
    const { confirmId, toolCallId, action } = req.body ?? {};

    if (typeof confirmId !== "string" || !confirmId.trim()) {
      res.status(400).json({ error: "confirmId 必须是非空字符串" });
      return;
    }
    if (typeof toolCallId !== "string" || !toolCallId.trim()) {
      res.status(400).json({ error: "toolCallId 必须是非空字符串" });
      return;
    }
    if (!isConfirmAction(action)) {
      res.status(400).json({ error: "action 必须是 allow 或 deny" });
      return;
    }

    // 会话不存在：聊天已结束、dispose 过、或 id 填错
    const session = getConfirmSession(confirmId.trim());
    if (!session) {
      res.status(404).json({ error: "确认会话不存在或已结束" });
      return;
    }

    // pending 不存在：已经点过、toolCallId 不对、或还没 wait 到
    const ok = session.resolve(toolCallId.trim(), action);
    if (!ok) {
      res.status(404).json({ error: "未找到对应的待确认工具调用" });
      return;
    }

    res.json({ ok: true, confirmId: session.confirmId, toolCallId, action });
  });

  /**
   * 调试：列出该会话当前卡住的确认项。
   * 正式产品可不暴露；学习 demo 便于 curl 排查。
   */
  app.get("/api/chat/confirm/:confirmId", (req, res) => {
    const session = getConfirmSession(req.params.confirmId);
    if (!session) {
      res.status(404).json({ error: "确认会话不存在或已结束" });
      return;
    }
    res.json({
      confirmId: session.confirmId,
      pending: session.listPending(),
    });
  });
}
