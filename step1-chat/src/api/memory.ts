/**
 * 长期记忆的 HTTP 客户端。
 *
 * 对应服务端 server/routes/memory.ts 的四条端点：
 *   GET    /api/memory?userId=            列出当前生效的记忆
 *   PATCH  /api/memory/:id?userId=        改 value / confidence
 *   DELETE /api/memory/:id?userId=        软删除一条
 *   DELETE /api/memory?userId=&confirm=all 清空全部
 *
 * 为什么单独一个文件而不是塞进 chat.ts：
 * 记忆管理和聊天流是两件事——聊天是 SSE 长连接，记忆是普通 CRUD。
 * 混在一起会让「关掉记忆开关后聊天还照常」这件事变得难读。
 */
import type { MemoryFact } from "../types";

/** 拼 userId 查询串；编码一次，避免参数里出现特殊字符时把 URL 拆坏。 */
function withUserId(path: string, userId: string): string {
  return `${path}?userId=${encodeURIComponent(userId)}`;
}

/** 读当前用户生效的记忆（服务端已过滤过期与软删除，按最近更新排序）。 */
export async function fetchMemoryFacts(userId: string): Promise<MemoryFact[]> {
  const response = await fetch(withUserId("/api/memory", userId));
  if (!response.ok) {
    throw new Error(`读取记忆失败（${response.status}）`);
  }
  const data = (await response.json()) as { facts?: MemoryFact[] };
  return Array.isArray(data.facts) ? data.facts : [];
}

/**
 * 修改一条记忆。
 *
 * 只允许改 value / confidence / expiresAt —— key、source、userId 是不可改的，
 * 服务端会直接 400，前端也不提供入口。
 *
 * **改 value 同时也是一次裁决**：冲突标记会被清掉（同 key 只留这一条）。
 * 面板上的「保留当前 / 用新值 / 合并」三个按钮都走这个接口。
 */
export async function updateMemoryFact(
  userId: string,
  factId: string,
  patch: { value?: string; confidence?: number },
): Promise<MemoryFact> {
  const response = await fetch(
    withUserId(`/api/memory/${encodeURIComponent(factId)}`, userId),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) {
    throw new Error(`更新记忆失败（${response.status}）`);
  }
  const data = (await response.json()) as { fact?: MemoryFact };
  if (!data.fact) throw new Error("更新记忆失败：返回内容缺少 fact");
  return data.fact;
}

/** 软删除一条记忆。 */
export async function deleteMemoryFact(userId: string, factId: string): Promise<void> {
  const response = await fetch(
    withUserId(`/api/memory/${encodeURIComponent(factId)}`, userId),
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`删除记忆失败（${response.status}）`);
  }
}

/** 清空全部记忆；服务端要求显式带 confirm=all。 */
export async function clearMemoryFacts(userId: string): Promise<number> {
  const response = await fetch(
    `${withUserId("/api/memory", userId)}&confirm=all`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`清空记忆失败（${response.status}）`);
  }
  const data = (await response.json()) as { deletedCount?: number };
  return typeof data.deletedCount === "number" ? data.deletedCount : 0;
}
