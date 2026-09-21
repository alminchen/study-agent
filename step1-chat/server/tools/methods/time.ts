/** 模型调用 getCurrentTime 时携带的参数。当前版本先不需要参数。 */
export interface GetCurrentTimeArgs {}

/** 程序执行 getCurrentTime 后得到的数据。 */
export interface CurrentTimeResult {
  iso: string;
  formatted: string;
  timezone: string;
}

/** 时间工具当前不需要参数；空字符串或 `{}` 都算合法。 */
export function parseGetCurrentTimeArgs(
  raw: string,
): { ok: true; args: GetCurrentTimeArgs } | { ok: false; error: string } {
  if (raw.trim() === "" || raw.trim() === "{}") {
    return { ok: true, args: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "getCurrentTime 参数不是合法 JSON" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "getCurrentTime 参数必须是对象或空对象" };
  }

  return { ok: true, args: {} };
}

/** 用本机时区生成当前时间，不是模型编的。 */
export function executeGetCurrentTime(_args: GetCurrentTimeArgs): CurrentTimeResult {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    iso: now.toISOString(),
    formatted: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
    }).format(now),
    timezone: timeZone,
  };
}

/** 给 findTool 用：解析参数失败也返回 `{ error }`，不往外 throw。 */
export function runGetCurrentTime(rawArguments: string): unknown {
  const parsed = parseGetCurrentTimeArgs(rawArguments);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return executeGetCurrentTime(parsed.args);
}
