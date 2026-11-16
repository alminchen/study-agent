/**
 * 步骤 2 自测：上传链路「落盘 + 建任务」。
 *
 * 覆盖学习计划的验收标准：
 *   1. 上传成功：磁盘有原件 + 任务为 queued（还没有任何向量）
 *   2. 上传非法文件：明确错误、不产生脏任务
 *   3. 刷新页面后任务还在（文件持久化在 data/kb/tasks.json）
 *
 * 注意：不调用 HTTP 服务，直接调 uploader / taskStore ——
 * 单测链路逻辑，不是端到端路由测试。
 *
 * 用法：npx tsx scripts/test-kb-upload.ts
 */
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { readFile as readTasksFile, writeFile } from "node:fs/promises";
import { uploadOriginal, UPLOAD_DIR } from "../server/kb/uploader.js";
import { listTasks } from "../server/kb/taskStore.js";
import type { KbTask } from "../server/kb/types.js";

const UPLOAD_BODY = {
  filename: "notes.md",
  category: "面试笔记",
  content: Buffer.from("# 动态知识库\n\n上传链路测试内容。").toString("base64"),
};

async function main(): Promise<void> {
  let uploaded: KbTask | null = null;
  let originalPath = "";
  try {
    console.log("1. 上传成功：落盘原件 + queued 任务");
    uploaded = await uploadOriginal(UPLOAD_BODY);
    if (uploaded.status !== "queued") {
      throw new Error(`任务状态应为 queued，实际 ${uploaded.status}`);
    }
    originalPath = path.join(UPLOAD_DIR, uploaded.docId, uploaded.filename);
    await access(originalPath);
    const bytes = await readFile(originalPath, "utf-8");
    if (!bytes.includes("上传链路测试内容")) {
      throw new Error("原件内容与上传不一致");
    }

    console.log("2. 非法类型被拒且不产生脏任务");
    let before = (await listTasks()).length;
    let rejected = false;
    try {
      await uploadOriginal({ ...UPLOAD_BODY, filename: "evil.pdf" });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("Markdown");
    }
    if (!rejected) throw new Error("PDF 上传应被拒绝");
    let after = (await listTasks()).length;
    if (after !== before) throw new Error("非法上传不应产生任务");

    console.log("3. 空文件被拒");
    before = (await listTasks()).length;
    rejected = false;
    try {
      await uploadOriginal({ ...UPLOAD_BODY, content: "" });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("空");
    }
    if (!rejected) throw new Error("空文件上传应被拒绝");
    after = (await listTasks()).length;
    if (after !== before) throw new Error("空文件不应产生任务");

    console.log("4. 跨目录文件名被拒（路径穿越）");
    rejected = false;
    try {
      await uploadOriginal({ ...UPLOAD_BODY, filename: "../evil.md" });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("路径");
    }
    if (!rejected) throw new Error("路径穿越文件应被拒绝");

    console.log("5. 任务持久化：重读列表仍在（模拟刷新）");
    const tasksNow = await listTasks();
    if (!tasksNow.some((task) => task.id === uploaded.id)) {
      throw new Error("任务未持久化，刷新后应仍在");
    }

    console.log("步骤 2 自测全部通过 ✓");
    const tasksFile = path.join(process.cwd(), "data", "kb", "tasks.json");
    if (uploaded) {
      const raw = JSON.parse(await readTasksFile(tasksFile, "utf-8")) as KbTask[];
      const cleaned = raw.filter((task) => task.id !== uploaded.id);
      await writeFile(tasksFile, JSON.stringify(cleaned, null, 2), "utf-8");
    }
  } finally {
    if (uploaded) {
      await rm(path.join(UPLOAD_DIR, uploaded.docId), {
        recursive: true,
        force: true,
      });
    }
  }
}

await main();
