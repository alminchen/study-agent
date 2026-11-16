// ============================================================
// 动态知识库 HTTP 路由：上传 / 任务列表 / 块预览 / 分类 / 检索 / 删除 / 重试
// ============================================================
//
// 干什么：把 kb 各层模块（uploader、taskStore、chunkStore、vectorStore、
//         categoryStore、search）接成 REST 端点，前端页面按这些端点操作。
// 步骤 2/4（上传/预览）、步骤 6（分类检索）、步骤 7（删除/重试/列表块数）已接入。
//
// 为什么路由层只做「接线」不做业务：
//   - 业务规则（校验、状态机、替换语义）都在各自模块里，测试脚本能直接调用；
//   - 路由层只负责「解析请求 -> 调模块 -> 包装响应」，换前端不用动业务层。
//
// 错误约定：输入校验失败回 400 + { ok:false, error }，前端据此提示用户；
//           内部异常回 500 + { ok:false, error }，不把程序 bug 伪装成用户错误。

// 导入：Express 类型（app 参数类型）
import type { Express } from "express";
// 删除事务最后一步用：删磁盘原件目录
import { rm } from "node:fs/promises";
// 拼原件目录路径 data/kb/uploads/{docId}
import path from "node:path";
// 上传：校验 + 落盘 + 建任务的入口、原件目录（删除事务最后一步用）
import { uploadOriginal, UPLOAD_DIR } from "../kb/uploader.js";
// 任务表：列表（含分页前的全量）、按文档删任务、失败重试
import { listTasks, removeTasksByDoc, retryTask } from "../kb/taskStore.js";
// 块表：列表页块数统计、块预览、删除事务第二环
import { countChunksByDoc, listChunksByDoc, removeChunksByDoc } from "../kb/chunkStore.js";
// 分类：建类（同名去重）、列表（前端下拉框数据源）
import { createCategory, listCategories } from "../kb/categoryStore.js";
// 检索：提问 -> 分类内 TopK 命中
import { askKnowledge } from "../kb/search.js";
// 向量表：删除事务第一环（先清检索数据，防止幽灵块）
import { removeVectorsByDoc } from "../kb/vectorStore.js";
// 上传请求体类型（路由层转交给 uploader 前先按它定型）
import type { KbUploadBody } from "../kb/types.js";

/**
 * 挂载全部 /api/kb/* 端点；由 server/routes/index.ts 启动时调用一次。
 */
export function registerKbRoutes(app: Express): void {
  /**
   * 上传：POST /api/kb/upload
   * 请求体 { filename, content(base64), category }。
   * 上传只是「收件」——切片与入库由后台 worker 推进（铁律二），必须秒回。
   */
  app.post("/api/kb/upload", async (req, res) => {
    try {
      // 走 uploader 的完整链路：校验 -> 落盘原件 -> 建 queued 任务
      const task = await uploadOriginal(req.body as KbUploadBody);
      // 2xx 返回任务记录，前端据此显示「排队中」并开始轮询
      res.json({ ok: true, task });
    } catch (error) {
      // 用户输入问题（文件名/分类/大小/扩展名等）→ 400 + 可读文案
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  /**
   * 任务列表：GET /api/kb/tasks
   * 返回全部任务 + 每篇文档的实时块数（列表页「块数」列的数据源）。
   * 块数不冗余在任务里：块表是唯一事实源，实时数避免状态字段过期。
   */
  app.get("/api/kb/tasks", async (_req, res) => {
    // 读出全部任务（createdAt 倒序由 taskStore.listTasks 保证）
    const tasks = await listTasks();
    // 逐条补齐实时块数：Promise.all 并行查块表，互不阻塞
    const withChunks = await Promise.all(
      tasks.map(async (task) => ({ ...task, chunkCount: await countChunksByDoc(task.docId) })),
    );
    // 一次性返回带块数的任务列表
    res.json({ ok: true, tasks: withChunks });
  });

  /**
   * 块预览：GET /api/kb/chunks?docId=xxx
   * 返回某篇文档的全部块（按 seq 排序）。
   * 用途：人眼确认块是否完整、标题有没有和正文拆开、overlap 影响的直观对照。
   * 只读块表，不触发切片、不触发向量化。
   */
  app.get("/api/kb/chunks", async (req, res) => {
    // 从 query 取 docId；缺失时直接拒绝（没有目标就没法预览）
    const docId = String(req.query.docId ?? "");
    if (!docId) {
      res.status(400).json({ ok: false, error: "docId 是必需的" });
      return;
    }
    // 查这篇文档的全部块（内部按 seq 排序）
    res.json({ ok: true, chunks: await listChunksByDoc(docId) });
  });

  /** 分类列表：GET /api/kb/categories（建类/选类前先看有哪些类，步骤 6）。 */
  app.get("/api/kb/categories", async (_req, res) => {
    // 读出全部分类（新的在前，前端下拉框直接展示）
    res.json({ ok: true, categories: await listCategories() });
  });

  /** 建分类：POST /api/kb/categories（名字去重，同名返回已有分类，步骤 6）。 */
  app.post("/api/kb/categories", async (req, res) => {
    try {
      // 从请求体取名字并去空白；空名字直接拒绝
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        res.status(400).json({ ok: false, error: "分类名不能为空" });
        return;
      }
      // createCategory 内部再做同名去重，返回建立/复用的分类记录
      const category = await createCategory(name);
      res.json({ ok: true, category });
    } catch (error) {
      // 文件读写异常等内部错误 → 400 文案兜底
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  /**
   * 按分类检索：POST /api/kb/search
   * 请求体 { question, category, topK? }；问句 embed 后只在指定分类里取 TopK。
   * 检索层硬过滤（不靠 prompt 约束），同时只扫已入库数据。
   */
  app.post("/api/kb/search", async (req, res) => {
    try {
      // 调 askKnowledge：校验 -> embed 提问 -> 分类内 TopK 检索
      const hits = await askKnowledge({
        question: String(req.body?.question ?? ""),
        category: String(req.body?.category ?? ""),
        topK: Number(req.body?.topK) || 5,
      });
      // 返回命中数组（前端直接渲染原文 + 分数）
      res.json({ ok: true, hits });
    } catch (error) {
      // 问题/分类为空 → 400 + 可读文案
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });

  /**
   * 删除文档：POST /api/kb/delete（步骤 7 删除事务）
   * 请求体 { docId }；顺序：删向量/块 -> 删任务记录 -> 删磁盘原件。
   * 为什么这个顺序：先清「可被搜到的数据」（向量/块），再清元数据，
   * 最后清原件——任一环失败都不会留下「搜得到但文档没了」的幽灵。
   */
  app.post("/api/kb/delete", async (req, res) => {
    // 从请求体取 docId；缺失时直接拒绝
    const docId = String(req.body?.docId ?? "").trim();
    if (!docId) {
      res.status(400).json({ ok: false, error: "docId 是必需的" });
      return;
    }
    try {
      // 第 1 环：删向量（检索数据先清，防止幽灵块继续被召回）
      await removeVectorsByDoc(docId);
      // 第 2 环：删块（预览/统计层同步清）
      await removeChunksByDoc(docId);
      // 第 3 环：删任务记录（列表不再出现这条文档）
      await removeTasksByDoc(docId);
      // 第 4 环：删磁盘原件目录（uploads/{docId}，递归强制，不存在也容忍）
      await rm(path.join(UPLOAD_DIR, docId), { recursive: true, force: true });
      // 返回成功标记
      res.json({ ok: true });
    } catch (error) {
      // 任一环失败 → 500 + 失败原因（事务性错误，前端可提示）
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: `删除失败：${message}` });
    }
  });

  /**
   * 失败任务重试：POST /api/kb/retry（步骤 7）
   * 请求体 { id }；把失败任务复位为 queued，由后台循环重新拾起。
   * docId 不变：重试不会重复建文档（步骤 7 验收点）。
   */
  app.post("/api/kb/retry", async (req, res) => {
    // 从请求体取任务 id；缺失时直接拒绝
    const id = String(req.body?.id ?? "").trim();
    if (!id) {
      res.status(400).json({ ok: false, error: "任务 id 是必需的" });
      return;
    }
    try {
      // retryTask：失败任务复位 queued 并返回最新记录；不是失败态会抛错
      const task = await retryTask(id);
      // 返回复位后的任务记录（前端可继续轮询状态）
      res.json({ ok: true, task });
    } catch (error) {
      // 任务不存在 / 非失败态 → 400 + 可读文案
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ ok: false, error: message });
    }
  });
}
