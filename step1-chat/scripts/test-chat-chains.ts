/**
 * 五链路回归（进阶学习第 8 项 · Memory · 指令 8 · E4）。
 *
 * 目的：确认「记忆」这一轮改造没有波及既有链路。
 *
 * 覆盖：
 *   POST /api/chat            单 Agent（唯一接了记忆的链路）
 *   POST /api/chat/multi      多 Agent
 *   POST /api/chat/plan       Plan-and-Execute
 *   POST /api/rag/chat        资料问答（RAG）
 *   POST /api/chat/structured 结构化输出
 *   GET  /api/memory          记忆管理接口（路由注册没把别的路由带坏）
 *
 * 跑法：`npm run test:chains`
 *
 * 为什么要起真实服务，而不是像别的脚本那样直接调函数：
 * 记忆改造动过 `routes/chat.ts`、`routes/index.ts` 和 `context/*`，
 * 这些都是「接线层」。只有真的发 HTTP 请求，才测得到接线对不对。
 *
 * 前置：需要可用的模型。脚本启动前会先探一次模型接口，
 * 不通就直接报错退出，不会拿一堆 503 当成「链路坏了」。
 */

import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";
import { clearMemory } from "../server/memory/store.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const PORT = Number(process.env.CHAIN_TEST_PORT ?? 8899);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const TEST_USER_ID = "anon_test_chain_e4";
/** 只跑名字里含该子串的链路，调试单条链路时省时间。 */
const CHAIN_FILTER = process.env.CHAIN_FILTER ?? "";
/** plan 链路天生慢（规划 + 每步执行），单独给更长的超时。 */
const PLAN_TIMEOUT_MS = Number(process.env.PLAN_TIMEOUT_MS ?? 240_000);
/** plan 链路要真的执行计划，任务越小步数越少、耗时越短。 */
const PLAN_TASK = process.env.PLAN_TASK ?? "用一句话说明 Vue 3 相比 Vue 2 的主要变化";

// 环境变量要在导入 server/index.js 之前设好：
// dotenv 不会覆盖已存在的环境变量，所以这里设的值优先于 .env。
process.env.PORT = String(PORT);
process.env.HOST = HOST;
process.env.LANGCHAIN_TRACING_V2 = "false";

interface ChainResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: ChainResult[] = [];

interface SseResult {
  status: number;
  events: Record<string, unknown>[];
  raw: string;
  /** 请求层面的失败（超时、连接不通），链路断言用。 */
  failure?: string;
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function shouldRun(tag: string): boolean {
  return CHAIN_FILTER === "" || CHAIN_FILTER === tag;
}

/** 解析 SSE 响应：返回事件数组（已 JSON.parse）与原始文本。 */
async function postSse(
  path: string,
  body: unknown,
  timeoutMs = 150_000,
): Promise<SseResult> {
  const controller = new AbortController();
  // 事件累积在闭包里：超时时要把「已经收到的部分」带出去，
  // 不能像普通错误处理那样把已解析的事件一起丢掉。
  const events: Record<string, unknown>[] = [];
  let raw = "";
  let sawDone = false;
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // abort 本身不该把进程带崩，忽略即可，下面统一按超时处理。
    }
  }, timeoutMs);
  try {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 边收边解析：SSE 是流式的，等 body 读完再解析的话，
      // 一旦超时，前面已经收到的事件会全部丢失。
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              sawDone = true;
              continue;
            }
            try {
              const parsed = JSON.parse(payload) as unknown;
              if (parsed && typeof parsed === "object") {
                events.push(parsed as Record<string, unknown>);
              }
            } catch {
              // 单个坏事件不算链路失败，交给断言看整体。
            }
          }
        }
        if (buffer.trim()) raw += buffer;
        if (sawDone) raw += "\ndata: [DONE]\n\n";
      } else {
        raw = await response.text();
      }
      return { status: response.status, events, raw };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 0,
        events,
        raw,
        failure: controller.signal.aborted ? `请求超时（${timeoutMs}ms）` : `请求失败：${message}`,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

function hasError(events: Record<string, unknown>[]): string | null {
  const errorEvent = events.find((event) => typeof event.error === "string");
  return errorEvent ? String(errorEvent.error) : null;
}

function countDeltas(events: Record<string, unknown>[]): number {
  return events.filter((event) => typeof event.delta === "string" && event.delta).length;
}

/** 等服务起来（import server/index.js 是异步 listen 的）。 */
async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没监听，继续等。
    }
    await delay(300);
  }
  throw new Error("服务启动超时");
}

/** 模型探活：不通就别往下跑，免得把「模型挂了」误判成「链路坏了」。 */
async function checkModelAvailable(): Promise<string> {
  const baseUrl = (process.env.LLM_BASE_URL ?? "").replace(/\/$/, "");
  const model = process.env.LLM_MODEL ?? "";
  if (!baseUrl || !model) return "未配置 LLM_BASE_URL / LLM_MODEL";
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LLM_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return "";
    const body = await response.text().catch(() => "");
    return `模型接口返回 ${response.status}：${body.slice(0, 160)}`;
  } catch (error) {
    return `模型接口不可达：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runChains(): Promise<void> {
  const model = process.env.LLM_MODEL ?? "deepseek-chat";
  const question = "用一句话说明 Vue 3 相比 Vue 2 的主要变化。";

  // ---- 1. 单 Agent（带记忆开关，确认记忆接线没把主链路带坏）----
  if (shouldRun("single")) {
    const result = await postSse("/api/chat", {
      messages: [{ role: "user", content: question }],
      model,
      userId: TEST_USER_ID,
      allowMemory: true,
    });
    const error = hasError(result.events);
    const memoryFailed = result.events.find((event) => event.type === "memory_failed");
    record(
      "POST /api/chat（单 Agent + 记忆开关）",
      result.status === 200 && !error && countDeltas(result.events) > 0 && !memoryFailed,
      [
        `HTTP ${result.status}`,
        `delta ${countDeltas(result.events)} 段`,
        error ? `错误事件：${error}` : "",
        memoryFailed ? `记忆链路失败：${JSON.stringify(memoryFailed)}` : "",
        result.raw.includes("[DONE]") ? "正常结束" : "缺少 [DONE]",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // ---- 2. 多 Agent ----
  if (shouldRun("multi")) {
    const result = await postSse("/api/chat/multi", {
      messages: [{ role: "user", content: question }],
      model,
    });
    const error = hasError(result.events);
    record(
      "POST /api/chat/multi（多 Agent）",
      result.status === 200 && !error && countDeltas(result.events) > 0,
      [
        `HTTP ${result.status}`,
        `delta ${countDeltas(result.events)} 段`,
        error ? `错误事件：${error}` : "",
        result.raw.includes("[DONE]") ? "正常结束" : "缺少 [DONE]",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // ---- 3. Plan-and-Execute ----
  if (shouldRun("plan")) {
    const result = await postSse("/api/chat/plan", {
      // 故意用极小的任务：plan 模式会真的执行计划，任务越小耗时越短，
      // 这次回归只验证「接线没坏」，不验证 plan 的规划质量。
      messages: [{ role: "user", content: PLAN_TASK }],
      model,
      mode: "plan",
    }, PLAN_TIMEOUT_MS);
    const error = hasError(result.events);
    const planEvents = result.events.filter((event) =>
      String(event.type ?? "").startsWith("plan_"),
    );
    record(
      "POST /api/chat/plan（Plan-and-Execute）",
      !result.failure && result.status === 200 && !error && planEvents.length > 0,
      [
        `HTTP ${result.status}`,
        result.failure ?? "",
        `plan 事件 ${planEvents.length} 个（${[
          ...new Set(planEvents.map((event) => String(event.type))),
        ].join("/") || "无"}）`,
        `delta ${countDeltas(result.events)} 段`,
        error ? `错误事件：${error}` : "",
        result.raw.includes("[DONE]") ? "正常结束" : "缺少 [DONE]",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // ---- 4. 资料问答（RAG）----
  if (shouldRun("rag")) {
    const result = await postSse("/api/rag/chat", {
      question: "Vue 3 的 Composition API 是什么？",
      history: [],
      model,
    });
    const error = hasError(result.events);
    const meta = result.events.find((event) => event.type === "rag_meta");
    record(
      "POST /api/rag/chat（资料问答）",
      result.status === 200 && !error && countDeltas(result.events) > 0,
      [
        `HTTP ${result.status}`,
        `delta ${countDeltas(result.events)} 段`,
        meta ? `rag_meta：命中 ${Array.isArray(meta.hits) ? meta.hits.length : 0} 条` : "缺 rag_meta",
        error ? `错误事件：${error}` : "",
        result.raw.includes("[DONE]") ? "正常结束" : "缺少 [DONE]",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // ---- 5. 结构化输出 ----
  if (shouldRun("structured")) {
    const result = await postSse("/api/chat/structured", {
      messages: [
        { role: "user", content: "给出一个用户列表表格，列是：姓名、邮箱、角色。" },
      ],
      model,
      target: "table",
    });
    const error = hasError(result.events);
    const done = result.events.find((event) => event.type === "structured_done");
    const snapshots = result.events.filter((event) => event.type === "structured_snapshot");
    record(
      "POST /api/chat/structured（结构化输出）",
      result.status === 200 && !error && Boolean(done),
      [
        `HTTP ${result.status}`,
        `快照 ${snapshots.length} 次`,
        done ? "收到 structured_done" : "缺 structured_done",
        error ? `错误事件：${error}` : "",
        result.raw.includes("[DONE]") ? "正常结束" : "缺少 [DONE]",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }

  // ---- 6. 记忆管理接口（路由注册没把别的路由带坏）----
  if (shouldRun("memory")) {
    const response = await fetch(`${BASE_URL}/api/memory?userId=${TEST_USER_ID}`);
    const body = (await response.json().catch(() => null)) as { facts?: unknown[] } | null;
    record(
      "GET /api/memory（记忆管理接口）",
      response.ok && Array.isArray(body?.facts),
      `HTTP ${response.status} · facts ${Array.isArray(body?.facts) ? body.facts.length : "非数组"}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`启动测试服务：${BASE_URL}（模型：${process.env.LLM_MODEL ?? "未配置"}）`);

  const modelError = await checkModelAvailable();
  if (modelError) {
    console.error(`模型不可用，回归测试无法进行：${modelError}`);
    console.error(
      "提示：模型名可在命令行覆盖，例如 LLM_MODEL=<可用模型名> npm run test:chains",
    );
    process.exit(2);
  }

  await import("../server/index.js");
  await waitForServer();

  try {
    await runChains();
  } finally {
    await clearMemory(TEST_USER_ID);
  }

  console.log("\n──────── 回归结果 ────────");
  results.forEach((item) => {
    console.log(`${item.ok ? "✅" : "❌"} ${item.name} —— ${item.detail}`);
  });
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 条链路通过`);

  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
