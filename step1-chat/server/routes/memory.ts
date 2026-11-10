/**
 * 跨会话记忆的 HTTP 接口：GET / POST / PATCH / DELETE /api/memory。
 *
 * 所属学习阶段：**进阶学习第 8 项 · Memory**
 * 专项计划：`tasks/memory-plan.md`
 *
 ## 这组接口在干什么
 *
 * 聊天链路（C1～C2）负责「自动」的部分：抽取出事实、注入上下文。
 * 这组接口负责「用户可控」的部分：看看到底记住了什么、改掉记错的、
 * 删掉不想留的。隐私要求是「用户能看到并删除」，所以它必须存在。
 *
 ## 四条端点
 *
 *   GET    /api/memory?userId=            列出当前生效的记忆
 *   POST   /api/memory                    手动写入一条
 *   PATCH  /api/memory/:id?userId=        修改 value / confidence / expiresAt
 *   DELETE /api/memory/:id?userId=        软删除一条
 *   DELETE /api/memory?userId=&confirm=all 清空全部
 *
 ## 四个刻意的取舍
 *
 * 1. **一切都要 userId**。服务端不采集真实身份，匿名 id 由前端生成、
 *    只存在 localStorage；但服务端仍然要靠它做归属校验，
 *    否则任何人都能读写别人的记忆（越权）。
 * 2. **不可改字段直接拒绝，而不是悄悄忽略**。PATCH 里传了 key/source，
 *    返回 400 并说明原因——静默忽略会让前端以为改成功了。
 * 3. **冲突不自动覆盖**。同 key 写了不同的值，旧记录被标上 conflict，
 *    由用户在面板里裁决；写错一条不会顺手把正确的那条也毁掉。
 * 4. **清空必须显式 confirm=all**。清空是不可撤销的（记录虽然保留在磁盘上，
 *    但对用户来说就是没了），少一个确认键比多一个麻烦安全。
 */

import type { Express } from "express";
import { z } from "zod";
import type { MergeOptions } from "../memory/merge.js";
import { normalizeKey } from "../memory/types.js";
import {
  clearMemory,
  createMemoryFact,
  deleteFact,
  readMemory,
  updateFact,
  upsertFact,
} from "../memory/store.js";
import {
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_SOURCES,
  MEMORY_USER_ID_PATTERN,
  MEMORY_VALUE_MAX_LENGTH,
} from "../memory/types.js";

/** 路由可选项：注入向量化实现（测试用假向量，生产用默认模型）。 */
export interface MemoryRouteOptions {
  /** 向量化实现，透传给存储层。 */
  embedder?: MergeOptions["embedder"];
}

/** 匿名用户 id：必须是 anon_ 前缀 + 1~64 位字母数字下划线连字符。 */
const UserIdSchema = z
  .string()
  .regex(MEMORY_USER_ID_PATTERN, "userId 必须形如 anon_xxxxxxxx");

/** GET 查询参数。 */
const GetMemoryQuerySchema = z.object({
  userId: z.string().min(1, "缺少 userId"),
});

/** POST 请求体。 */
const CreateMemoryBodySchema = z.object({
  userId: z.string().min(1, "缺少 userId"),
  key: z.string().min(1, "key 不能为空").max(MEMORY_KEY_MAX_LENGTH, "key 过长"),
  value: z.string().min(1, "value 不能为空").max(MEMORY_VALUE_MAX_LENGTH, "value 过长"),
  source: z.enum(MEMORY_SOURCES),
  confidence: z.number("confidence 必须是数字"),
});

/** PATCH 请求体：只有这三个字段可改。 */
const UpdateMemoryBodySchema = z.object({
  value: z.string().min(1, "value 不能为空").max(MEMORY_VALUE_MAX_LENGTH, "value 过长").optional(),
  confidence: z.number("confidence 必须是数字").optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
});

/** PATCH / DELETE 都禁止修改的字段。 */
const IMMUTABLE_FIELDS = ["key", "userId", "source", "createdAt"] as const;

/** 从 query 里取一个字符串参数（数组/对象都当作非法）。 */
function readQueryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 挂载记忆管理接口。 */
export function registerMemoryRoutes(app: Express, options: MemoryRouteOptions = {}): void {
  const mergeOptions: MergeOptions = options.embedder ? { embedder: options.embedder } : {};

  /** B1 · 列出当前生效的记忆（已过滤过期与软删除，按最近更新排序）。 */
  app.get("/api/memory", async (req, res) => {
    const parsed = GetMemoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "缺少或非法的 userId" });
      return;
    }
    const userId = parsed.data.userId;
    if (!UserIdSchema.safeParse(userId).success) {
      res.status(400).json({ error: "userId 必须形如 anon_xxxxxxxx" });
      return;
    }
    res.json({ facts: await readMemory(userId) });
  });

  /** B2 · 手动写入一条记忆；同 key 同值合并，同 key 不同值标记冲突。 */
  app.post("/api/memory", async (req, res) => {
    const parsed = CreateMemoryBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "请求体不合法",
        detail: parsed.error.issues[0]?.message,
      });
      return;
    }
    const body = parsed.data;
    if (!UserIdSchema.safeParse(body.userId).success) {
      res.status(400).json({ error: "userId 必须形如 anon_xxxxxxxx" });
      return;
    }

    // 置信度在 createMemoryFact 里夹进 [0.6, 1]。
    const incoming = createMemoryFact({
      userId: body.userId,
      key: normalizeKey(body.key),
      value: body.value.trim(),
      source: body.source,
      confidence: body.confidence,
    });

    const result = await upsertFact(body.userId, incoming, mergeOptions);
    if (!result.fact) {
      res.status(500).json({ error: "记忆写入失败" });
      return;
    }
    // 顶层再带一个 conflict，方便前端不必钻进 fact 里找。
    res.json({ fact: result.fact, conflict: result.fact.conflict === true });
  });

  /** B3 · 修改一条记忆；改 value 可能触发新的冲突标记。 */
  app.patch("/api/memory/:id", async (req, res) => {
    const userId = readQueryString(req.query.userId);
    if (!UserIdSchema.safeParse(userId).success) {
      res.status(400).json({ error: "缺少或非法的 userId" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const immutable = IMMUTABLE_FIELDS.find((field) => field in body);
    if (immutable) {
      res.status(400).json({ error: `字段 ${immutable} 不可修改` });
      return;
    }

    const parsed = UpdateMemoryBodySchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({
        error: "请求体不合法",
        detail: parsed.error.issues[0]?.message,
      });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: "没有可修改的字段" });
      return;
    }

    const fact = await updateFact(userId, String(req.params.id ?? ""), parsed.data);
    if (!fact) {
      // 找不到和跨用户都返回 404：分不清「不存在」和「不是你的」，
      // 否则这条接口就成了探测别人记忆 id 的工具。
      res.status(404).json({ error: "记忆不存在" });
      return;
    }
    res.json({ fact, conflict: fact.conflict === true });
  });

  /** B4 · 软删除一条记忆（记录保留在磁盘上，可审计）。 */
  app.delete("/api/memory/:id", async (req, res) => {
    const userId = readQueryString(req.query.userId);
    if (!UserIdSchema.safeParse(userId).success) {
      res.status(400).json({ error: "缺少或非法的 userId" });
      return;
    }
    const fact = await deleteFact(userId, String(req.params.id ?? ""));
    if (!fact) {
      res.status(404).json({ error: "记忆不存在" });
      return;
    }
    res.json({ ok: true, deletedCount: 1, fact });
  });

  /** B4 · 清空全部记忆；必须显式带 confirm=all。 */
  app.delete("/api/memory", async (req, res) => {
    const userId = readQueryString(req.query.userId);
    if (!UserIdSchema.safeParse(userId).success) {
      res.status(400).json({ error: "缺少或非法的 userId" });
      return;
    }
    if (readQueryString(req.query.confirm) !== "all") {
      res.status(400).json({ error: "清空全部记忆需要 confirm=all" });
      return;
    }
    const deletedCount = await clearMemory(userId);
    res.json({ ok: true, deletedCount });
  });
}
