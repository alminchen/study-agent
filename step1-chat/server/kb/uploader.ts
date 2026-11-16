// ============================================================
// 上传壳：校验 -> 落盘原件 -> 建 queued 任务
// ============================================================
//
// 干什么：接收用户上传的 Markdown，落盘到 data/kb/uploads/{docId}/，
//         并登记一条 queued 任务，然后立刻返回——这步只做「收件」。
//
// 铁律（dynamic-kb-learning-plan.md）：本模块只收文件、不留向量。
// 切片与入库全部交给后台 worker，上传请求必须秒回。
// 为什么：上传是用户可感知的同步操作；切片/embedding 要加载模型、耗时不确定，
//         放进上传链路会让「传个文件」变成「等好久」，体验和架构都差。
//         拆成「秒回 + 后台推进」后，用户随时回来查状态即可（状态机存在的意义）。
//
// 决策（见 tasks/dynamic-kb-step0-assets.md）：
//   项目无 multer 依赖，上传走 JSON + base64；限 1MB、只收 .md。
//   好处：零新增依赖；base64 客户端一行组包；1MB 对学习期 md 文档绰绰有余。

// 导入：mkdir 建上传目录、writeFile 落盘原件
import { mkdir, writeFile } from "node:fs/promises";
// path：拼 data/kb/uploads/{docId}/{filename} 的路径
import path from "node:path";
// 任务表：建任务拿 docId、落盘失败时置 failed
import { createTask, getTask } from "./taskStore.js";
// 线协议类型：KbTask 是任务记录、KbUploadBody 是上传请求体
import type { KbTask, KbUploadBody } from "./types.js";

// 上传文件大小上限：1MB（按 base64 解码后的字节数算，不是字符串长度）
export const MAX_UPLOAD_BYTES = 1024 * 1024;

// 只收 Markdown（学习计划第一版约束，避免把二进制/其他格式混进知识库）
const ALLOWED_EXTENSION = ".md";

/**
 * 上传原件根目录：项目根下 data/kb/uploads/{docId}/。
 * 每篇文档一个子目录、原件用原始文件名，删除事务按目录整清（步骤 7）。
 */
const UPLOAD_DIR = path.join(process.cwd(), "data", "kb", "uploads");

// ------------------------------------------------------------
// 校验错误：与内部异常区分开
// ------------------------------------------------------------

/**
 * 校验失败抛出的错误，路由层据此返回明确文案（400 + 人类可读信息）。
 * 区分于内部异常：内部异常是程序 bug（500），校验失败是用户输入问题（400）。
 */
export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

/**
 * 文件名取 basename：防止 path traversal。
 * 用户传的 filename 若含 ../ 或 /，拼路径时会逃出上传目录写任意位置——
 * 这是文件上传最经典的漏洞之一，所以校验「basename 后必须还是原名」。
 */
function safeFilename(raw: string): string {
  // 只取路径最后一段（node 跨平台：Windows 反斜杠也会被处理）
  const base = path.basename(raw.trim());
  // basename 结果必须等于原名：有任何目录成分（../ 或 /）都会被识破
  if (!base || base !== raw.trim()) {
    throw new UploadValidationError("文件名不合法：只能包含文件名本身，不能含路径");
  }
  return base;
}

/**
 * 校验请求体并取出 base64 解码后的字节（不落盘，纯校验）。
 * 逐个检查：请求体存在、文件名合法、扩展名 .md、分类非空、内容非空、大小不超限。
 * 任何一项不过都抛 UploadValidationError，路由层转成 400。
 */
export function validateUpload(body: KbUploadBody): { filename: string; category: string; bytes: Buffer } {
  // 请求体整体缺失 → 直接拒绝
  if (!body || typeof body !== "object") {
    throw new UploadValidationError("请求体缺失");
  }
  // 提取并校验文件名（含路径穿越检查）
  const filename = safeFilename(String(body.filename ?? ""));
  // 扩展名必须 .md（大小写不敏感）
  if (!filename.toLowerCase().endsWith(ALLOWED_EXTENSION)) {
    throw new UploadValidationError("只支持 Markdown 文件（.md）");
  }
  // 分类必须选定：null/undefined/空串都被挡下
  const category = String(body.category ?? "").trim();
  if (!category) {
    throw new UploadValidationError("请选择分类后再上传");
  }
  // 内容必须非空（base64 字符串本身不能是空）
  const content = String(body.content ?? "");
  if (!content) {
    throw new UploadValidationError("文件内容为空");
  }
  // base64 解码成字节；解码为空也算空文件
  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0) {
    throw new UploadValidationError("文件内容为空");
  }
  // 超出 1MB 上限拒绝（防止内存/磁盘被撑爆）
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadValidationError("文件超过 1MB 上限");
  }
  return { filename, category, bytes };
}

/**
 * 上传入口：校验 -> 落盘原件 -> 建任务。返回新任务；任务状态固定为 queued。
 *
 * 顺序细节：先建任务（拿 docId）再落盘，因为原件路径要用 docId 命名目录；
 * 若落盘失败，把任务置为 failed(read)，不留「说排着队、文件其实没存上」的假象。
 *
 * 不在这里做任何 embedding / 切分——那属于后台 worker（步骤 3~5）。
 */
export async function uploadOriginal(body: KbUploadBody): Promise<KbTask> {
  // 第 1 步：纯校验，拿到文件名、分类、解码后的字节
  const { filename, category, bytes } = validateUpload(body);
  // 第 2 步：先建任务拿 docId——原件落盘路径要用它命名目录
  const task = await createTask({ filename, category });
  try {
    // 第 3 步：建目录 data/kb/uploads/{docId}/
    const dir = path.join(UPLOAD_DIR, task.docId);
    await mkdir(dir, { recursive: true });
    // 第 4 步：把解码字节以原始文件名写盘（这就是「原件」）
    await writeFile(path.join(dir, filename), bytes);
  } catch (error) {
    // 落盘失败：任务不留着误导用户，置 failed(read) 并说明原因
    const { updateTask } = await import("./taskStore.js");
    await updateTask(task.id, {
      status: "failed",
      stage: "read",
      error: `原件落盘失败：${error instanceof Error ? error.message : String(error)}`,
    });
    // 返回最新任务记录（带了 failed 状态），调用方看到的不是过期的 queued
    return (await getTask(task.id)) ?? task;
  }
  // 正常路径：任务保持 queued，等后台循环认领
  return task;
}

// 导出供其他模块使用：getTask 查任务、UPLOAD_DIR 定位原件目录（删除事务用）
export { getTask, UPLOAD_DIR };
