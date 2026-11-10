/**
 * 前端聊天状态中枢（Vue composable）。
 *
 * 职责：维护 messages / 流式状态 / ToolTrace / Usage；按模式把 send/retry 分到
 *   - 普通对话 → runStream → streamChat（/api/chat 或 /api/chat/multi，SSE）
 *   - 资料问答 → runRag → askRag（/api/rag/chat，SSE）
 *   - 结构化输出 → runStructured → streamStructured（/api/chat/structured，SSE）
 * 两边共用 runSseSession 骨架（开流、占位气泡、回调、收尾）。
 *
 * 不负责：拼 system、跑 ReAct、检索、计 Token（都在服务端）。
 */
import { onMounted, ref, watch } from "vue";
import {
  confirmChatTool,
  fetchHealth,
  streamChat,
  streamPlan,
  streamReflection,
  streamStructured,
} from "../api/chat";
import { fetchModelCatalog } from "../api/models";
import {
  clearMemoryFacts,
  deleteMemoryFact,
  fetchMemoryFacts,
  updateMemoryFact,
} from "../api/memory";
import { askRag } from "../api/rag";
import { fetchUsageSummary } from "../api/usage";
import {
  FALLBACK_MODEL_OPTIONS,
  type ChatMessage,
  type ContextCompactionEvent,
  type ContextSummary,
  type MemoryFact,
  type ModelOption,
  type PlanEvent,
  type PlanMode,
  type PlanRuntimeState,
  type StructuredTarget,
  type ToolTraceStep,
  type UsageSnapshot,
  type UsageSummary,
} from "../types";
import { normalizeContextSummary } from "../types";

// 普通对话和 RAG 分开存储；模型/开关也各自持久化，刷新后恢复用户选择。
const HISTORY_KEY = "step1-chat:history";
const RAG_HISTORY_KEY = "step1-chat:rag-history";
const MODEL_KEY = "step1-chat:model";
const RAG_MODE_KEY = "step1-chat:rag-mode";
const SEARCH_KB_KEY = "step1-chat:search-kb";
/** 普通对话是否走多 Agent；与 searchKb 独立。缺省 true（multi）。 */
const MULTI_AGENT_KEY = "step1-chat:multi-agent";
/** 是否把普通对话切到 /api/chat/plan 链路。 */
const PLAN_ENABLED_KEY = "step1-chat:plan-enabled";
/** 计划链路的模式：auto 按规则路由，react 强制 ReAct，plan 强制进 Planner。 */
const PLAN_MODE_KEY = "step1-chat:plan-mode";
/** 是否把普通对话切到 /api/chat/reflection 链路（先出一版再自我评估）。 */
const REFLECTION_ENABLED_KEY = "step1-chat:reflection-enabled";
/**
 * 上下文摘要单独存一份 key，与聊天历史分开：
 * 历史可能被用户清空，摘要是「跨轮记忆」，两者生命周期不同。
 */
const CONTEXT_SUMMARY_KEY = "step1-chat:context-summary";
/** 匿名用户 id：跨会话记忆的归属标识，只存本地，不含任何真实身份。 */
const MEMORY_USER_ID_KEY = "step1-chat:memory-user-id";
/** 是否允许长期记忆；没写过时默认允许。 */
const MEMORY_ENABLED_KEY = "step1-chat:memory-enabled";

/** 匿名 id 的合法格式；与服务端 memory/types.ts 的 MEMORY_USER_ID_PATTERN 一致。 */
const MEMORY_USER_ID_PATTERN = /^anon_[A-Za-z0-9_-]{1,64}$/;

/**
 * 生成匿名 id：anon_ + 8 位随机串。
 *
 * crypto.randomUUID 只在安全上下文（https / localhost）里有，
 * 用局域网 IP 打开页面时会取不到，所以必须留兜底：
 * 有 randomUUID 用它 → 没有用 getRandomValues → 再没有退回 Math.random。
 */
function generateMemoryUserId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `anon_${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toLowerCase()}`;
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `anon_${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
  }
  return `anon_${Array.from(
    { length: 8 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("")}`;
}

/**
 * 读匿名 id：没有、或者存坏了，都不复用，直接生成一个新的。
 *
 * 复用坏 id 只会让请求一直 400；重新生成一次就回到「合法但陌生」的状态。
 */
function loadMemoryUserId(): string {
  try {
    const raw = localStorage.getItem(MEMORY_USER_ID_KEY);
    if (raw && MEMORY_USER_ID_PATTERN.test(raw)) return raw;
  } catch {
    // localStorage 不可用（隐私模式等）：退化成一次性 id，本次会话仍然可用。
  }
  const userId = generateMemoryUserId();
  try {
    localStorage.setItem(MEMORY_USER_ID_KEY, userId);
  } catch {
    // 存不进去就算了，本次会话仍然能用这个 id。
  }
  return userId;
}

// 页面内自增 id 只需稳定且唯一；时间戳前缀便于排查跨会话消息。
let idCounter = 0;
const createId = () => `msg_${Date.now()}_${idCounter++}`;

/** 只把最终结构化结果带到下一轮模型上下文，不把 partial snapshot 当历史。 */
function toApiMessages(history: ChatMessage[]) {
  return history.flatMap(({ role, content, structured }) => {
    // 普通文本消息保持原样；结构化消息必须已经完成才能进入模型上下文。
    if (!structured) return [{ role, content }];
    if (structured.status !== "completed" || !structured.result) return [];
    return [{ role, content: JSON.stringify(structured.result) }];
  });
}

/** 流式中的结构化消息可以展示，但落盘时必须降级为最终结果或直接移除。 */
function persistableHistory(history: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of history) {
    if (!message.structured) {
      result.push(message);
      continue;
    }
    if (message.structured.status !== "completed" || !message.structured.result) {
      // 未完成、失败和中止的结构化结果不能污染刷新后的历史。
      continue;
    }
    result.push({
      ...message,
      structured: {
        ...message.structured,
        // snapshot 只服务当前生成过程，持久化时只保留最终 result。
        snapshot: null,
      },
    });
  }
  return result;
}

/** 从 localStorage 读历史；兼容旧数据缺 rag.hits 字段的情况。 */
function loadHistory(key: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((message) => {
      // 兼容旧版本可能写入的半成品结构化消息；读取时直接丢弃。
      if (
        message.structured &&
        (message.structured.status !== "completed" || !message.structured.result)
      ) {
        return [];
      }

      // RAG 历史做字段补全，兼容早期缺少 hits/rerank 字段的数据。
      const normalized: ChatMessage = message.rag
        ? {
            ...message,
            rag: {
              ...message.rag,
              question: message.rag.question ?? "",
              hits: (message.rag.hits ?? []).map((hit) => ({
                ...hit,
                rerankRank: hit.rerankRank ?? null,
                rerankScore: hit.rerankScore ?? null,
              })),
            },
          }
        : message;

      // 已完成的结构化历史统一恢复为 completed，并清掉临时 snapshot。
      if (!normalized.structured?.result) return [normalized];
      return [
        {
          ...normalized,
          structured: {
            ...normalized.structured,
            status: "completed",
            snapshot: null,
          },
        },
      ];
    });
  } catch {
    return [];
  }
}

/** 模式切换时由同一个 key 选择器保证两条链路不会读到彼此历史。 */
function historyKey(ragMode: boolean): string {
  return ragMode ? RAG_HISTORY_KEY : HISTORY_KEY;
}

/**
 * 从 localStorage 读摘要。
 *
 * 摘要结构可能来自旧版本或被用户改坏：版本不认识就整份丢弃，
 * 单条内容不对就只丢那一条。读取失败一律当作「没有摘要」，不影响聊天。
 */
function loadContextSummary(): ContextSummary | null {
  try {
    const raw = localStorage.getItem(CONTEXT_SUMMARY_KEY);
    if (!raw) return null;
    return normalizeContextSummary(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function useChat() {
  // 普通对话和资料问答各存一份历史，切换模式时互不污染。
  const ragMode = ref(localStorage.getItem(RAG_MODE_KEY) === "1");
  const searchKb = ref(localStorage.getItem(SEARCH_KB_KEY) === "1");
  // 未写过 localStorage 时默认多 Agent；显式存过 "0" 则单 Agent
  const multiAgent = ref(localStorage.getItem(MULTI_AGENT_KEY) !== "0");
  /** 是否把普通对话切到 /api/chat/plan；与 ragMode、multiAgent 互不影响。 */
  const planEnabled = ref(localStorage.getItem(PLAN_ENABLED_KEY) === "1");
  const planMode = ref<PlanMode>(
    (localStorage.getItem(PLAN_MODE_KEY) as PlanMode | null) ?? "auto",
  );
  /**
   * 是否走 Reflection 链路（先出一版答案，再自我评估、必要时重写）。
   *
   * 与 ragMode / planEnabled 互不影响；服务端 REFLECTION_MODE 仍是上限，
   * 这里只决定前端走不走 /api/chat/reflection 这条端点。
   */
  const reflectionEnabled = ref(
    localStorage.getItem(REFLECTION_ENABLED_KEY) === "1",
  );
  const messages = ref<ChatMessage[]>(loadHistory(historyKey(ragMode.value)));
  const modelOptions = ref<ModelOption[]>([...FALLBACK_MODEL_OPTIONS]);
  const model = ref(localStorage.getItem(MODEL_KEY) ?? FALLBACK_MODEL_OPTIONS[0].id);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);
  /** 过程面板：tool_call / pending_confirm / injection_detected …（SSE onTrace） */
  const toolTrace = ref<ToolTraceStep[]>([]);
  /** 最近一次请求的 Token 摘要（SSE usage 事件） */
  const lastUsage = ref<UsageSnapshot | null>(null);
  const usageSummary = ref<UsageSummary | null>(null);
  const serverMode = ref<"mock" | "api" | "unknown">("unknown");
  /** 计划请求的运行时状态；步骤 10 的时间线 UI 直接读它。 */
  const planState = ref<PlanRuntimeState | null>(null);
  /**
   * 跨轮保留的上下文摘要（服务端压缩后回传，前端持久化后下次带回）。
   * 与聊天历史分开存：历史可清空，摘要是长期记忆。
   */
  const contextSummary = ref<ContextSummary | null>(loadContextSummary());
  /** 最近一次请求的上下文压缩事件；只在真的发生压缩时才有值。 */
  const contextCompaction = ref<ContextCompactionEvent | null>(null);
  /**
   * 匿名用户 id：跨会话记忆的归属标识。
   * 首次访问生成后固定下来，刷新页面不变——它变了就等于「换了个人」。
   */
  const memoryUserId = ref(loadMemoryUserId());
  /** 是否允许长期记忆（默认开）。关掉后既不注入也不再抽取。 */
  const allowMemory = ref(localStorage.getItem(MEMORY_ENABLED_KEY) !== "0");
  /** 面板里展示的记忆列表。 */
  const memoryFacts = ref<MemoryFact[]>([]);
  /** 记忆列表的加载状态；出错时只更新错误文案，不打断聊天。 */
  const memoryLoading = ref(false);
  /** 记忆操作（读/改/删/清空）的错误文案。 */
  const memoryError = ref<string | null>(null);
  /** 当前进行中的 SSE 请求；stop() 对其 abort */
  let abortController: AbortController | null = null;
  /** 每次会话递增，旧请求的迟到回调不得污染新消息或全局状态。 */
  let activeSessionId = 0;

  // 首屏只读取健康状态和 usage 汇总，不主动发起聊天请求。
  onMounted(() => {
    void fetchHealth().then((info) => {
      serverMode.value = info?.mode ?? "unknown";
    });
    void loadModelOptions();
    void refreshUsageSummary();
    void refreshMemoryFacts();
  });

  /** 顶栏模型列表以服务端 /api/models 为准；失败时保留兜底列表。 */
  async function loadModelOptions() {
    const catalog = await fetchModelCatalog();
    if (!catalog || catalog.models.length === 0) return;

    modelOptions.value = catalog.models;
    // 已保存的模型若已不在供应商列表里，切到第一个可用项，避免下拉空白。
    if (!catalog.models.some((option) => option.id === model.value)) {
      changeModel(catalog.models[0].id);
    }
  }

  async function refreshUsageSummary() {
    // usage 汇总失败时保留旧值；面板不因一次刷新失败阻塞聊天。
    usageSummary.value = await fetchUsageSummary();
  }

  /**
   * 拉取当前匿名用户的记忆列表。
   *
   * 失败只写错误文案：记忆是附加能力，读不到不影响聊天。
   */
  async function refreshMemoryFacts() {
    memoryLoading.value = true;
    try {
      memoryFacts.value = await fetchMemoryFacts(memoryUserId.value);
      memoryError.value = null;
    } catch (error) {
      memoryError.value = error instanceof Error ? error.message : "读取记忆失败";
    } finally {
      memoryLoading.value = false;
    }
  }

  /** 开关长期记忆：即时生效，从下一轮请求开始起作用。 */
  function setAllowMemory(next: boolean) {
    allowMemory.value = next;
    localStorage.setItem(MEMORY_ENABLED_KEY, next ? "1" : "0");
  }

  /**
   * 换一套匿名身份。
   *
   * 用途是「验证跨会话记忆」：换 id 之后旧记忆不再被检索到，
   * 面板列表也会换成新身份（通常是空的）。
   */
  function resetMemoryUserId() {
    const userId = generateMemoryUserId();
    localStorage.setItem(MEMORY_USER_ID_KEY, userId);
    memoryUserId.value = userId;
    memoryFacts.value = [];
    void refreshMemoryFacts();
  }

  /**
   * 编辑一条记忆（value / confidence）。
   *
   * 先改本地列表再同步接口（乐观更新）；接口失败回滚，
   * 用户看到的是「改没改成」，而不是中途闪一下又跳回去。
   *
   * 改 value 同时也是一次冲突裁决：服务端会清掉冲突标记、
   * 同 key 只留这一条（面板的三个裁决按钮都走这条路）。
   */
  async function updateMemory(
    factId: string,
    patch: { value?: string; confidence?: number },
  ) {
    const previous = memoryFacts.value;
    memoryFacts.value = previous.map((fact) =>
      fact.id === factId ? { ...fact, ...patch } : fact,
    );
    try {
      const updated = await updateMemoryFact(memoryUserId.value, factId, patch);
      memoryFacts.value = memoryFacts.value.map((fact) =>
        fact.id === factId ? updated : fact,
      );
      memoryError.value = null;
    } catch (error) {
      memoryFacts.value = previous;
      memoryError.value = error instanceof Error ? error.message : "更新记忆失败";
    }
  }

  /** 删除一条记忆（服务端软删除，磁盘上仍可审计）。 */
  async function removeMemory(factId: string) {
    const previous = memoryFacts.value;
    memoryFacts.value = previous.filter((fact) => fact.id !== factId);
    try {
      await deleteMemoryFact(memoryUserId.value, factId);
      memoryError.value = null;
    } catch (error) {
      memoryFacts.value = previous;
      memoryError.value = error instanceof Error ? error.message : "删除记忆失败";
    }
  }

  /** 清空全部记忆；不可撤销，所以入口由面板做二次确认。 */
  async function clearMemories() {
    const previous = memoryFacts.value;
    memoryFacts.value = [];
    try {
      await clearMemoryFacts(memoryUserId.value);
      memoryError.value = null;
    } catch (error) {
      memoryFacts.value = previous;
      memoryError.value = error instanceof Error ? error.message : "清空记忆失败";
    }
  }

  /** 计划状态的初始值；route 事件先到时也要有一份空状态。 */
  function emptyPlanState(): PlanRuntimeState {
    return {
      planId: "",
      revision: 0,
      plan: null,
      planHistory: [],
      stepResults: [],
      route: null,
      fallback: null,
      planError: null,
      finished: false,
      finishedStatus: null,
    };
  }

  /** 按计划里的步骤生成初始步骤状态。 */
  function pendingSteps(plan: PlanRuntimeState["plan"]): PlanRuntimeState["stepResults"] {
    if (!plan) return [];
    return plan.steps.map((step) => ({
      stepId: step.id,
      status: "pending",
      summary: "",
      toolsCalled: [],
    }));
  }

  /**
   * 归并一个计划事件。
   *
   * 四条不变量：
   * - planId 不同的事件一律忽略（迟到的旧请求不能污染新计划）。
   * - revision 只增不减，旧版本不能覆盖新版本。
   * - Re-plan 追加到 planHistory，不覆盖旧计划。
   * - plan_finished 之后不再接受步骤事件。
   */
  function applyPlanEvent(event: PlanEvent): void {
    const state = planState.value ?? (planState.value = emptyPlanState());
    if (state.finished && event.type !== "plan_finished") return;

    switch (event.type) {
      case "plan_route":
        state.route = {
          mode: event.mode,
          reasonCode: event.reasonCode,
          signals: event.signals,
        };
        return;

      case "plan_created":
        if (state.planId && state.planId !== event.planId) return;
        state.planId = event.planId;
        state.revision = Math.max(state.revision, event.revision);
        state.plan = event.plan;
        state.planHistory = [...state.planHistory, event.plan];
        state.stepResults = pendingSteps(event.plan);
        return;

      case "plan_step_started":
        if (event.planId !== state.planId || event.revision < state.revision) return;
        state.stepResults = state.stepResults.map((row) =>
          row.stepId === event.stepId ? { ...row, status: "running" } : row,
        );
        return;

      case "plan_step_done":
        if (event.planId !== state.planId || event.revision < state.revision) return;
        state.stepResults = state.stepResults.map((row) =>
          row.stepId === event.stepId
            ? {
                ...row,
                status: "done",
                summary: event.summary,
                toolsCalled: event.toolsCalled,
              }
            : row,
        );
        return;

      case "plan_step_failed":
        if (event.planId !== state.planId || event.revision < state.revision) return;
        // stepId 为空表示步骤级之外的失败（如最终回答失败），不改步骤状态。
        if (!event.stepId) {
          state.planError = { code: event.code, message: event.message };
          return;
        }
        state.stepResults = state.stepResults.map((row) =>
          // 同一个步骤可能先收到根因失败、再收到计划级收尾失败；
          // 步骤上保留第一条（根因），后续消息不覆盖。
          row.stepId === event.stepId && row.status !== "failed"
            ? { ...row, status: "failed", summary: event.message, errorCode: event.code }
            : row,
        );
        return;

      case "plan_replanned": {
        if (event.planId !== state.planId || event.revision <= state.revision) return;
        // 已完成步骤原样保留；新计划多出来的步骤重新置为 pending。
        const doneRows = state.stepResults.filter((row) => row.status === "done");
        state.planHistory = [...state.planHistory, event.plan];
        state.revision = event.revision;
        state.plan = event.plan;
        state.stepResults = [
          ...doneRows,
          ...pendingSteps(event.plan).filter(
            (row) => !doneRows.some((done) => done.stepId === row.stepId),
          ),
        ];
        return;
      }

      case "plan_finished":
        state.finished = true;
        state.finishedStatus = event.status;
        // 未执行到的步骤标记为 skipped，已完成的保持不变。
        state.stepResults = state.stepResults.map((row) =>
          row.status === "pending" || row.status === "running"
            ? { ...row, status: "skipped" }
            : row,
        );
        return;

      case "plan_fallback":
        state.fallback = { reasonCode: event.reasonCode, message: event.message };
        return;
    }
  }

  /** 中止时保留已完成步骤，把没跑到的步骤标记为 skipped。 */
  function markPlanAborted(): void {
    const state = planState.value;
    if (!state || state.finished) return;
    state.stepResults = state.stepResults.map((row) =>
      row.status === "pending" || row.status === "running"
        ? { ...row, status: "skipped" }
        : row,
    );
  }

  // 流式结束后再落盘，避免半成品气泡写进 localStorage
  watch([messages, isStreaming, ragMode], () => {
    if (!isStreaming.value) {
      localStorage.setItem(
        historyKey(ragMode.value),
        JSON.stringify(persistableHistory(messages.value)),
      );
    }
  });

  function persistCurrentHistory() {
    // 用户消息和完成消息在请求边界立即落盘，不等待 watch 的下一次调度。
    localStorage.setItem(
      historyKey(ragMode.value),
      JSON.stringify(persistableHistory(messages.value)),
    );
  }

  /**
   * SSE 会话公共骨架（runStream / runRag 共用）：
   * 开流 → 占位 assistant → 回调灌状态 → 中止/失败收尾。
   * 差异只在 `start`：调哪个 API、请求体怎么拼、有无 rag_meta。
   *
   * 等待期间用空气泡 + 光标表示进行中（与原先 JSON askRag 等待体验一致；
   * 现 RAG 也是 SSE，答案经 onDelta 写入）。
   */
  async function runSseSession(
    history: ChatMessage[],
    options: {
      emptyErrorFallback: string;
      start: (ctx: {
        signal: AbortSignal;
        patchLatest: (updater: (prev: ChatMessage) => ChatMessage) => void;
        onDelta: (delta: string) => void;
        onTrace: (step: ToolTraceStep) => void;
        onUsage: (usage: UsageSnapshot) => void;
        onError: (message: string) => void;
        /** 计划事件（plan_*）；只有计划链路会用到，普通链路忽略。 */
        onPlanEvent?: (event: PlanEvent) => void;
        /** 上下文压缩事件；只有普通对话链路会用到。 */
        onContextCompacted?: (event: ContextCompactionEvent) => void;
      }) => Promise<boolean>;
    },
  ) {
    // ---- 1. 开流：本请求专用 AbortController，可被 stop() 打断 ----
    // 新请求先终止旧请求，再生成新的 sessionId，旧回调会因 id 不匹配被忽略。
    abortController?.abort();
    const sessionId = ++activeSessionId;
    const isCurrentSession = () => activeSessionId === sessionId;
    const controller = new AbortController();
    abortController = controller;
    isStreaming.value = true;
    error.value = null;
    toolTrace.value = [];
    lastUsage.value = null;
    // 压缩提示只反映「最近一次请求」：本轮没压缩就不显示旧提示。
    contextCompaction.value = null;

    // ---- 2. 占位 assistant：先插空气泡，后续 onDelta / onRagMeta 往里灌 ----
    // assistant 占位消息让页面在首个 snapshot/delta 前也有稳定的渲染目标。
    const assistantId = createId();
    let latest: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages.value = [...history, latest];

    const patchLatest = (updater: (prev: ChatMessage) => ChatMessage) => {
      if (!isCurrentSession()) return;
      latest = updater(latest);
      messages.value = messages.value.map((message) =>
        message.id === assistantId ? latest : message,
      );
    };

    // ---- 3. 交给具体 API（streamChat / askRag），统一接四类回调 ----
    // 这四个函数由本骨架实现，再原样传给 api 层；api 解析 SSE 后按事件类型回调。
    // start 返回 true 表示协议正常完成；返回值只影响最终空回复兜底。
    const done = await options.start({
      signal: controller.signal,
      patchLatest,
      // onDelta：SSE { delta } → 拼进当前 assistant 气泡正文（流式打字）
      onDelta: (delta) => {
        patchLatest((prev) => ({ ...prev, content: prev.content + delta }));
      },
      // onTrace：SSE 过程事件 → ToolTracePanel（tool_call / confirm / injection…）
      onTrace: (step) => {
        if (!isCurrentSession()) return;
        if (step.kind === "confirm_resolved") {
          // 只更新对应 pending 状态，不再追加一条，避免面板重复
          toolTrace.value = toolTrace.value.map((row) => {
            if (row.kind === "pending_confirm" && row.toolCallId === step.toolCallId) {
              return { ...row, status: step.action };
            }
            return row;
          });
          return;
        }
        toolTrace.value = [...toolTrace.value, step];
        // 记忆抽取是 fire-and-forget 的，事件可能在本轮之后才到；
        // 到了就刷新面板列表，让「记住了什么」立刻可见。
        if (step.kind === "memory_extracted") {
          void refreshMemoryFacts();
        }
      },
      // onUsage：SSE { type:"usage" } → 本次 Token 摘要 + 刷新汇总面板
      onUsage: (usage) => {
        if (!isCurrentSession()) return;
        lastUsage.value = usage;
        void refreshUsageSummary();
      },
      // onError：SSE { error } 或网络失败 → 顶栏/气泡错误文案
      onError: (message) => {
        if (!isCurrentSession()) return;
        error.value = message;
      },
      // onPlanEvent：计划事件 → 计划运行时状态；旧会话的迟到事件直接丢弃。
      onPlanEvent: (event) => {
        if (!isCurrentSession()) return;
        applyPlanEvent(event);
      },
      // onContextCompacted：服务端压缩了上下文 → 更新摘要并立刻落盘。
      // 摘要失败（degraded）时事件里没有新摘要，保留旧摘要不动。
      onContextCompacted: (event) => {
        if (!isCurrentSession()) return;
        contextCompaction.value = event;
        if (!event.summary) return;
        contextSummary.value = event.summary;
        localStorage.setItem(CONTEXT_SUMMARY_KEY, JSON.stringify(event.summary));
      },
    });

    // ---- 4. 收尾：清 abort 引用、关 streaming、补中止/失败文案 ----
    // 旧请求在 await 期间可能已被 clear/new request 替代，收尾必须再次检查 session。
    if (!isCurrentSession()) return;
    if (abortController === controller) abortController = null;
    isStreaming.value = false;

    // 结构化消息由自己的 status 表示结果，不能套用普通文本的“空回复”文案。
    if (latest.structured) {
      // 结构化请求正常 done 时 status 已经是 completed；这里只补未完成终态。
      if (latest.structured.status === "streaming") {
        latest = {
          ...latest,
          structured: {
            ...latest.structured,
            status: controller.signal.aborted ? "incomplete" : "error",
            errorCode:
              controller.signal.aborted ? undefined : "model_stream_interrupted",
          },
        };
        if (!controller.signal.aborted) {
          error.value ??= options.emptyErrorFallback;
        }
      }
      messages.value = messages.value.map((message) =>
        message.id === assistantId ? latest : message,
      );
      return;
    }

    // 普通文本链路保留原有“停止/失败/空回复”兜底文案。
    if (controller.signal.aborted && latest.content === "") {
      latest = { ...latest, content: "已停止生成。" };
    }
    if (!done && !controller.signal.aborted && latest.content.trim() === "") {
      latest = { ...latest, content: error.value ?? options.emptyErrorFallback };
    }
    if (done || controller.signal.aborted || (!done && latest.content.trim() !== "")) {
      messages.value = messages.value.map((message) =>
        message.id === assistantId ? latest : message,
      );
    }
  }

  /**
   * 普通对话：endpoint 由 multiAgent 决定；searchKb 只传 searchDocs。
   * - multiAgent true  → POST /api/chat/multi
   * - multiAgent false → POST /api/chat
   * searchDocs 只进请求体，不参与选路（与「多 Agent」开关解耦）。
   */
  async function runStream(history: ChatMessage[], selectedModel: string) {
    await runSseSession(history, {
      emptyErrorFallback: "请求失败，请重试。",
      start: ({ signal, onDelta, onTrace, onUsage, onError, onContextCompacted }) =>
        streamChat({
          messages: toApiMessages(history),
          model: selectedModel,
          signal,
          searchDocs: searchKb.value,
          multiAgent: multiAgent.value,
          // 带上上轮摘要：服务端会把它作为独立的一条 system 消息注入。
          contextSummary: contextSummary.value,
          // 跨会话记忆：关掉开关时连 userId 一起不带，服务端零注入。
          userId: memoryUserId.value,
          allowMemory: allowMemory.value,
          // 以下四个来自 runSseSession，实现见上方骨架第 3 步：
          onDelta, // 助手正文流式增量
          onTrace, // 工具/确认/防护过程 → ToolTracePanel
          onUsage, // Token 用量 → UsagePanel
          onContextCompacted, // 上下文压缩 → 摘要持久化 + 压缩提示
          onError, // 失败文案
        }),
    });
  }

  /**
   * 计划模式对话：POST /api/chat/plan（SSE）。
   *
   * 与 runStream 共用 SSE 骨架，差异只有两点：
   * - 计划事件进 planState（步骤 10 的时间线 UI 读它）。
   * - 正文仍是最终回答的 delta，与普通链路一致。
   */
  async function runPlan(history: ChatMessage[], selectedModel: string) {
    planState.value = emptyPlanState();
    // 用 holder 持有 signal：闭包里赋值，局部变量会被 TS 控制流收窄成 null。
    const holder: { signal?: AbortSignal } = {};
    await runSseSession(history, {
      emptyErrorFallback: "计划执行失败，请重试。",
      start: ({ signal, onDelta, onTrace, onUsage, onError, onPlanEvent }) => {
        holder.signal = signal;
        return streamPlan({
          messages: toApiMessages(history),
          model: selectedModel,
          signal,
          mode: planMode.value,
          searchDocs: searchKb.value,
          // 跨会话记忆：关掉开关时连 userId 一起不带，服务端零注入。
          userId: memoryUserId.value,
          allowMemory: allowMemory.value,
          onPlanEvent: onPlanEvent ?? (() => {}),
          onDelta,
          onTrace,
          onUsage,
          onError,
        });
      },
    });
    // 中止后不跑下一步：把没执行到的步骤标成 skipped，已完成步骤保留。
    if (holder.signal?.aborted) markPlanAborted();
  }

  /** 结构化输出：同一个 SSE 骨架，正文由 snapshot/result 驱动而不是 delta。 */
  async function runStructured(
    history: ChatMessage[],
    selectedModel: string,
    target: StructuredTarget,
  ) {
    await runSseSession(history, {
      emptyErrorFallback: "结构化输出失败，请重试。",
      start: ({ signal, patchLatest, onTrace, onUsage, onError }) => {
        // 请求一开始就建立结构化状态，让页面立即显示骨架而不是空白气泡。
        patchLatest((prev) => ({
          ...prev,
          structured: {
            target,
            status: "streaming",
            revision: 0,
            snapshot: null,
            result: null,
          },
        }));

        return streamStructured({
          messages: toApiMessages(history),
          model: selectedModel,
          target,
          // 跨会话记忆：关掉开关时连 userId 一起不带，服务端零注入。
          userId: memoryUserId.value,
          allowMemory: allowMemory.value,
          signal,
          // 记忆过程事件 → 工具过程面板（注入 / 抽取 / 失败）。
          onTrace,
          onSnapshot: (event) => {
            patchLatest((prev) => {
              const state = prev.structured;
              // 只接受 streaming 状态下更大的 revision，阻止重复/迟到快照。
              if (
                !state ||
                state.status !== "streaming" ||
                event.revision <= state.revision
              ) {
                return prev;
              }
              return {
                ...prev,
                structured: {
                  ...state,
                  revision: event.revision,
                  snapshot: event.snapshot,
                },
              };
            });
          },
          onDone: (event) => {
            patchLatest((prev) => {
              const state = prev.structured;
              // done 之后状态不可逆；重复 done 或 done-after-abort 都直接忽略。
              if (!state || state.status !== "streaming") return prev;
              return {
                ...prev,
                structured: {
                  ...state,
                  status: "completed",
                  revision: event.revision,
                  result: event.result,
                },
              };
            });
          },
          onUsage,
          onError: (structuredError) => {
            // 顶层错误给用户可读文案，消息内部仍保留机器错误码。
            onError("结构化输出失败，请重试。");
            patchLatest((prev) => {
              const state = prev.structured;
              // 已完成结果不能被晚到的错误覆盖；其余失败保留最大 revision。
              if (!state || state.status === "completed") return prev;
              return {
                ...prev,
                structured: {
                  ...state,
                  status: "error",
                  revision: Math.max(state.revision, structuredError.lastRevision),
                  errorCode: structuredError.code,
                },
              };
            });
          },
        });
      },
    });
  }

  /**
   * Reflection 链路：POST /api/chat/reflection（SSE）。
   *
   * 与 runStream 的差别：
   * - 请求体只带问题，不带历史；服务端自己生成初版答案。
   * - 正文不流式：服务端在「初评 → 重写 → 重评」结束后一次性推 delta，
   *   前端只拼接这一次，所以不会拼出两段答案。
   * - 过程事件（工具轨迹 + 评分/重写/跳过）统一进 ToolTracePanel。
   */
  async function runReflection(history: ChatMessage[], selectedModel: string) {
    const lastUser = [...history].reverse().find((message) => message.role === "user");
    const question = lastUser?.content.trim() ?? "";
    if (!question) return;
    await runSseSession(history, {
      emptyErrorFallback: "反思请求失败，请重试。",
      start: ({ signal, onDelta, onTrace, onUsage, onError }) =>
        streamReflection({
          question,
          model: selectedModel,
          signal,
          sessionId: createId(),
          searchDocs: searchKb.value,
          onDelta,
          onTrace,
          onUsage,
          onError,
        }),
    });
  }

  /**
   * 资料问答：POST /api/rag/chat（SSE，与 chat 同形态）。
   * 过程事件进 ToolTracePanel；命中进 message.rag（RagHitPanel）；答案走 delta。
   * 服务端先 toolGuard(searchDocs) → 检索判空再决定是否调模型。
   */
  async function runRag(history: ChatMessage[], selectedModel: string) {
    const lastUser = [...history].reverse().find((message) => message.role === "user");
    const question = lastUser?.content.trim() ?? "";
    // 当前问句已经在 history 末尾，传给后端的 history 必须去掉它，避免拼 prompt 时重复。
    const prior = toApiMessages(history.slice(0, -1));

    await runSseSession(history, {
      emptyErrorFallback: "资料问答失败。",
      start: ({ signal, patchLatest, onDelta, onTrace, onUsage, onError }) =>
        askRag({
          question,
          history: prior,
          model: selectedModel,
          signal,
          // 跨会话记忆：关掉开关时连 userId 一起不带，服务端零检索。
          userId: memoryUserId.value,
          allowMemory: allowMemory.value,
          // 与 runStream 相同：四个回调由 runSseSession 注入（正文 / Trace / Token / 错误）
          onDelta,
          onTrace,
          onUsage,
          // rag_meta：命中面板元数据；与 delta 分开，避免只靠拼字丢 hits
          onRagMeta: (meta) => {
            patchLatest((prev) => ({
              ...prev,
              rag: {
                empty: meta.empty,
                calledModel: meta.calledModel,
                topScore: meta.topScore,
                question: meta.question,
                hits: meta.hits,
                rewriteMeta: meta.rewriteMeta,
                kbRouteMeta: meta.kbRouteMeta,
                multiQueryMeta: meta.multiQueryMeta,
                hydeMeta: meta.hydeMeta,
              },
            }));
          },
          onError,
        }),
    });
  }

  /** 发送：先落 user 气泡，再按 ragMode 选链路。 */
  async function send(content: string) {
    const trimmed = content.trim();
    if (!trimmed || isStreaming.value) return;
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    const history = [...messages.value, userMessage];
    messages.value = history;
    persistCurrentHistory();
    if (ragMode.value) {
      await runRag(history, model.value);
      return;
    }
    if (planEnabled.value) {
      await runPlan(history, model.value);
      return;
    }
    if (reflectionEnabled.value) {
      await runReflection(history, model.value);
      return;
    }
    await runStream(history, model.value);
  }

  /** 结构化发送入口；本步骤只做表格/代码基础模式，页面体验在后续任务完善。 */
  async function sendStructured(content: string, target: StructuredTarget) {
    const trimmed = content.trim();
    if (!trimmed || isStreaming.value) return;
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    const history = [...messages.value, userMessage];
    messages.value = history;
    persistCurrentHistory();
    await runStructured(history, model.value, target);
  }

  /** 重试：去掉末尾失败/空的 assistant，用最后一条 user 再跑同一链路。 */
  async function retry() {
    if (isStreaming.value) return;
    const current = messages.value;
    const lastMessage = current[current.length - 1];
    // 重试结构化消息时沿用原 target，避免用户切换选择器后重跑成另一种类型。
    const structuredTarget =
      lastMessage?.role === "assistant" ? lastMessage.structured?.target : undefined;
    const history =
      lastMessage?.role === "assistant" ? current.slice(0, -1) : current;
    if (history.length === 0 || history[history.length - 1]?.role !== "user") return;
    if (structuredTarget) {
      // 先去掉失败 assistant，再用最后一条 user 重新发起结构化请求。
      await runStructured(history, model.value, structuredTarget);
      return;
    }
    if (ragMode.value) {
      await runRag(history, model.value);
      return;
    }
    if (planEnabled.value) {
      await runPlan(history, model.value);
      return;
    }
    if (reflectionEnabled.value) {
      await runReflection(history, model.value);
      return;
    }
    await runStream(history, model.value);
  }

  function stop() {
    // AbortController 会同时中断浏览器 fetch 和服务端上游模型请求。
    abortController?.abort();
    markPlanAborted();
  }

  /**
   * 过程面板点「允许 / 拒绝」。
   *
   * 本函数只做两件事：
   * 1. 把对应 pending 标成 resolving（按钮不可再点）
   * 2. POST /api/chat/confirm → 服务端 ConfirmSession.resolve，解开 applyToolCalls 里的 await wait()
   *
   * 【没有】在这里继续跑工具或再发一轮聊天——下一步全在服务端、且仍是同一条未结束的 SSE：
   *   wait 返回 → allow 则 run / deny 则回填 { error: 用户拒绝 }
   *   → SSE 推 confirm_resolved、tool_result
   *   →（multi）Aggregate → onDelta；或（单 Agent）再 askModel → onDelta → [DONE]
   * 前端靠 runStream 里仍在跑的 streamChat 循环收这些事件（onTrace / onDelta），不必再调 send。
   *
   * 前提：isStreaming 仍为 true（原聊天 SSE 还挂着）。点太晚或已停止，confirm 会 404。
   * 资料问答路径无人工确认，不会走到这里。
   */
  async function resolveToolConfirm(payload: {
    confirmId: string;
    toolCallId: string;
    action: "allow" | "deny";
  }) {
    toolTrace.value = toolTrace.value.map((row) => {
      if (row.kind === "pending_confirm" && row.toolCallId === payload.toolCallId) {
        return { ...row, status: "resolving" };
      }
      return row;
    });
    try {
      await confirmChatTool(payload);
    } catch (err) {
      error.value = err instanceof Error ? err.message : "确认请求失败";
      // 解开失败：恢复可点，便于重试
      toolTrace.value = toolTrace.value.map((row) => {
        if (row.kind === "pending_confirm" && row.toolCallId === payload.toolCallId) {
          return { ...row, status: "pending" };
        }
        return row;
      });
    }
  }

  function clear() {
    stop();
    // 主动递增 sessionId，确保 clear 后旧请求的任何回调都不能恢复消息。
    activeSessionId += 1;
    abortController = null;
    isStreaming.value = false;
    messages.value = [];
    error.value = null;
    toolTrace.value = [];
    lastUsage.value = null;
    planState.value = null;
    contextCompaction.value = null;
    // 摘要按消息下标覆盖历史；历史清空后下标全部失效，必须一起清掉。
    contextSummary.value = null;
    localStorage.removeItem(CONTEXT_SUMMARY_KEY);
    localStorage.setItem(historyKey(ragMode.value), "[]");
  }

  function changeModel(nextModel: string) {
    // 模型选择只影响后续请求；当前流式请求不会被切换动作重写。
    model.value = nextModel;
    localStorage.setItem(MODEL_KEY, nextModel);
  }

  function setSearchKb(next: boolean) {
    searchKb.value = next;
    localStorage.setItem(SEARCH_KB_KEY, next ? "1" : "0");
  }

  function setMultiAgent(next: boolean) {
    multiAgent.value = next;
    localStorage.setItem(MULTI_AGENT_KEY, next ? "1" : "0");
  }

  /** 切换是否走计划端点；只影响后续请求。 */
  function setPlanEnabled(next: boolean) {
    planEnabled.value = next;
    localStorage.setItem(PLAN_ENABLED_KEY, next ? "1" : "0");
    if (!next) planState.value = null;
  }

  /** 计划链路的模式（auto / react / plan）；只影响后续请求。 */
  function setPlanMode(next: PlanMode) {
    planMode.value = next;
    localStorage.setItem(PLAN_MODE_KEY, next);
  }

  /** 是否走 Reflection 链路；只影响后续请求。 */
  function setReflectionEnabled(next: boolean) {
    reflectionEnabled.value = next;
    localStorage.setItem(REFLECTION_ENABLED_KEY, next ? "1" : "0");
  }

  /** 切换时先落下当前会话，再载入另一条链路的历史。 */
  function setRagMode(next: boolean) {
    if (next === ragMode.value || isStreaming.value) return;
    persistCurrentHistory();
    ragMode.value = next;
    localStorage.setItem(RAG_MODE_KEY, next ? "1" : "0");
    messages.value = loadHistory(historyKey(next));
    error.value = null;
    toolTrace.value = [];
    lastUsage.value = null;
    planState.value = null;
    // 换了链路，上一轮的压缩提示不再对应当前会话。
    contextCompaction.value = null;
  }

  return {
    messages,
    model,
    modelOptions,
    ragMode,
    searchKb,
    multiAgent,
    planEnabled,
    planMode,
    reflectionEnabled,
    planState,
    isStreaming,
    error,
    toolTrace,
    lastUsage,
    usageSummary,
    serverMode,
    contextSummary,
    contextCompaction,
    memoryUserId,
    allowMemory,
    memoryFacts,
    memoryLoading,
    memoryError,
    send,
    sendStructured,
    retry,
    stop,
    clear,
    changeModel,
    setRagMode,
    setSearchKb,
    setMultiAgent,
    setPlanEnabled,
    setPlanMode,
    setReflectionEnabled,
    refreshUsageSummary,
    refreshMemoryFacts,
    setAllowMemory,
    resetMemoryUserId,
    updateMemory,
    removeMemory,
    clearMemories,
    resolveToolConfirm,
  };
}
