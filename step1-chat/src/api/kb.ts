// ============================================================
// 动态知识库前端 API 客户端
// ============================================================
//
// 干什么：把 /api/kb/* 端点包装成类型化的 fetch 函数，供知识库面板调用。
// 为什么单独成文件：与 chat.ts / rag.ts 一致——视图层不直接写 fetch，
//   换后端地址、改字段名只改这一处，组件只认这里的类型。
// 好处：组件里看不到 URL 字符串和 JSON 解析，专注交互状态。

// 任务状态：与服务端 server/kb/types.ts 的 KbTaskStatus 同名同义
export type KbTaskStatus =
  | "queued" // 排队中：已收件，还没被 worker 取走
  | "chunking" // 切片中：worker 正在切块
  | "chunked" // 已切完：块可预览，但还没有向量
  | "embedding" // 入库中：正在向量化
  | "searchable" // 可检索：提问只扫这一层
  | "failed"; // 失败：配合 stage 看停点

// 任务失败停点：读原件 / 切片 / 向量化
export type KbTaskStage = "read" | "chunk" | "embed";

// 一条任务记录（列表页的行）：字段与服务端 KbTask 对齐
export interface KbTask {
  id: string; // 任务 id
  docId: string; // 文档身份：替换单位
  filename: string; // 原始文件名
  category: string; // 所属分类
  status: KbTaskStatus; // 当前状态
  stage: KbTaskStage | null; // 失败停点；成功为 null
  error: string | null; // 失败原因；成功为 null
  chunkCount: number | null; // 切出的块数
  createdAt: number; // 创建时间
  updatedAt: number; // 最近状态变更时间
}

// 列表页任务：在 KbTask 上补一个实时块数（路由层已并行查好）
export interface KbTaskWithChunks extends KbTask {
  chunkCount: number; // 列表页展示的实时块数
}

// 一条分类：下拉框 / 标签用
export interface KbCategory {
  id: string; // 分类 id
  name: string; // 分类名
  createdAt: number; // 创建时间
}

// 一条块：块预览面板展示用
export interface KbChunk {
  id: string; // 块 id
  source: string; // 来源文件名
  title: string; // 所属标题
  text: string; // 块正文
  seq: number; // 块内序号
  category: string; // 所属分类
  docId: string; // 文档身份
}

// 一条检索命中：提问结果展示用
export interface KbAskHit {
  category: string; // 命中所属分类
  source: string; // 来源文件名
  docId: string; // 文档身份
  seq: number; // 块内序号
  text: string; // 块原文
  score: number; // 余弦相似度（0~1）
}

// 统一响应壳：成功带 ok:true，失败带 ok:false + error
type KbResponse<T> = {
  ok: boolean;
  error?: string;
} & Partial<T>;

/**
 * 把 fetch 包装成「解析 JSON + 抛可读错误」的小工具。
 * 好处：每个具体函数只写一行调用，不重复 try/catch 和状态码判断。
 */
async function kbFetch<T>(url: string, init?: RequestInit): Promise<T> {
  // 发起请求；网络层异常统一转成「网络请求失败」文案
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("网络请求失败");
  }
  // 非 2xx / 业务失败都从这里抛，调用方 catch 后显示给用户
  const data = (await response.json().catch(() => ({}))) as KbResponse<T>;
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || `服务异常：${response.status}`);
  }
  // 断言成完整形状：各端点已在服务端保证字段齐全
  return data as T;
}

/**
 * 上传：POST /api/kb/upload。
 * body 走 JSON + base64，与项目无 multer 的现状一致（学习计划决策）。
 */
export function uploadKbFile(params: {
  filename: string; // 原始文件名
  content: string; // base64 内容
  category: string; // 目标分类
}): Promise<{ task: KbTask }> {
  return kbFetch("/api/kb/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/**
 * 任务列表：GET /api/kb/tasks。
 * 返回全部任务 + 实时块数，前端轮询它推进状态显示。
 */
export function listKbTasks(): Promise<{ tasks: KbTaskWithChunks[] }> {
  return kbFetch("/api/kb/tasks");
}

/**
 * 块预览：GET /api/kb/chunks?docId=xxx。
 * 只读块表，不触发切片/向量化。
 */
export function listKbChunks(docId: string): Promise<{ chunks: KbChunk[] }> {
  return kbFetch(`/api/kb/chunks?docId=${encodeURIComponent(docId)}`);
}

/**
 * 分类列表：GET /api/kb/categories。下拉框数据源。
 */
export function listKbCategories(): Promise<{ categories: KbCategory[] }> {
  return kbFetch("/api/kb/categories");
}

/**
 * 建分类：POST /api/kb/categories。同名去重，返回建立/复用的分类。
 */
export function createKbCategory(name: string): Promise<{ category: KbCategory }> {
  return kbFetch("/api/kb/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/**
 * 分类内检索：POST /api/kb/search。返回 TopK 命中（带来源）。
 */
export function searchKbCategory(params: {
  question: string; // 问题
  category: string; // 分类硬边界
  topK?: number; // 可选，默认 5
}): Promise<{ hits: KbAskHit[] }> {
  return kbFetch("/api/kb/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/**
 * 删除文档：POST /api/kb/delete。服务端按向量/块/任务/原件顺序清理。
 */
export function deleteKbDoc(docId: string): Promise<Record<string, never>> {
  return kbFetch("/api/kb/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId }),
  });
}

/**
 * 失败任务重试：POST /api/kb/retry。复位 queued 由 worker 续跑。
 */
export function retryKbTask(id: string): Promise<{ task: KbTask }> {
  return kbFetch("/api/kb/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}
