/**
 * draft_message — 执行侧（假发送）。
 *
 * 约定与其它 tools/methods 一致：
 * - 入参仍是模型给的 arguments 字符串
 * - 解析失败或业务失败返回 `{ error: string }`，不 throw
 * - findTool().run / runToolWithTracing 都走 runDraftMessage
 *
 * 人工确认在 applyToolCalls 里完成：deny 时根本不会调用到本文件。
 */

/** 模型调用 draft_message 时携带的参数 */
export interface DraftMessageArgs {
  /** 收件人或对象展示名 */
  to: string;
  /** 消息正文 */
  body: string;
}

/**
 * 假执行成功时的结构。
 * simulated: true 明确告诉模型和前端：没有真的发到外部渠道。
 */
export interface DraftMessageResult {
  ok: true;
  simulated: true;
  to: string;
  body: string;
  message: string;
}

/**
 * 解析并校验 arguments JSON。
 * 与 weather/time 一样返回判别联合，方便 run 层统一成 { error }。
 */
export function parseDraftMessageArgs(
  raw: string,
): { ok: true; args: DraftMessageArgs } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "draft_message 参数不是合法 JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "draft_message 参数必须是对象" };
  }

  const row = parsed as { to?: unknown; body?: unknown };
  if (typeof row.to !== "string" || !row.to.trim()) {
    return { ok: false, error: "draft_message.to 必须是非空字符串" };
  }
  if (typeof row.body !== "string" || !row.body.trim()) {
    return { ok: false, error: "draft_message.body 必须是非空字符串" };
  }

  return { ok: true, args: { to: row.to.trim(), body: row.body.trim() } };
}

/**
 * 仅模拟成功：打一行日志方便本地观察，返回固定成功结构。
 * 以后若接真 API，只改这里，确认协议不用动。
 */
export function executeDraftMessage(args: DraftMessageArgs): DraftMessageResult {
  console.log(`[draft_message] 模拟发送 → to=${args.to} body=${args.body.slice(0, 80)}`);
  return {
    ok: true,
    simulated: true,
    to: args.to,
    body: args.body,
    message: "已模拟发送（学习用，未真正外发）",
  };
}

/** 给 findTool / applyToolCalls 用的统一入口 */
export function runDraftMessage(rawArguments: string): unknown {
  const parsed = parseDraftMessageArgs(rawArguments);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return executeDraftMessage(parsed.args);
}
