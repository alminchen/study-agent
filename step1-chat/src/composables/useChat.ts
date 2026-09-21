/**
 * 前端聊天状态中枢（Vue composable）。
 *
 * 职责：维护 messages / 流式状态 / ToolTrace / Usage；按模式把 send/retry 分到
 *   - 普通对话 → runStream → streamChat（/api/chat 或 /api/chat/multi，SSE）
 *   - 资料问答 → runRag → askRag（/api/rag/chat，SSE）
 * 两边共用 runSseSession 骨架（开流、占位气泡、回调、收尾）。
 *
 * 不负责：拼 system、跑 ReAct、检索、计 Token（都在服务端）。
 */
import { onMounted, ref, watch } from "vue";
import { confirmChatTool, fetchHealth, streamChat } from "../api/chat";
import { askRag } from "../api/rag";
import { fetchUsageSummary } from "../api/usage";
import { MODEL_OPTIONS, type ChatMessage, type ToolTraceStep, type UsageSnapshot, type UsageSummary } from "../types";

const HISTORY_KEY = "step1-chat:history";
const RAG_HISTORY_KEY = "step1-chat:rag-history";
const MODEL_KEY = "step1-chat:model";
const RAG_MODE_KEY = "step1-chat:rag-mode";
const SEARCH_KB_KEY = "step1-chat:search-kb";
/** 普通对话是否走多 Agent；与 searchKb 独立。缺省 true（multi）。 */
const MULTI_AGENT_KEY = "step1-chat:multi-agent";

let idCounter = 0;
const createId = () => `msg_${Date.now()}_${idCounter++}`;

/** 从 localStorage 读历史；兼容旧数据缺 rag.hits 字段的情况。 */
function loadHistory(key: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((message) => {
      if (!message.rag) return message;
      return {
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
      };
    });
  } catch {
    return [];
  }
}

function historyKey(ragMode: boolean): string {
  return ragMode ? RAG_HISTORY_KEY : HISTORY_KEY;
}

export function useChat() {
  // 普通对话和资料问答各存一份历史，切换模式时互不污染。
  const ragMode = ref(localStorage.getItem(RAG_MODE_KEY) === "1");
  const searchKb = ref(localStorage.getItem(SEARCH_KB_KEY) === "1");
  // 未写过 localStorage 时默认多 Agent；显式存过 "0" 则单 Agent
  const multiAgent = ref(localStorage.getItem(MULTI_AGENT_KEY) !== "0");
  const messages = ref<ChatMessage[]>(loadHistory(historyKey(ragMode.value)));
  const model = ref(localStorage.getItem(MODEL_KEY) ?? MODEL_OPTIONS[0].id);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);
  /** 过程面板：tool_call / pending_confirm / injection_detected …（SSE onTrace） */
  const toolTrace = ref<ToolTraceStep[]>([]);
  /** 最近一次请求的 Token 摘要（SSE usage 事件） */
  const lastUsage = ref<UsageSnapshot | null>(null);
  const usageSummary = ref<UsageSummary | null>(null);
  const serverMode = ref<"mock" | "api" | "unknown">("unknown");
  /** 当前进行中的 SSE 请求；stop() 对其 abort */
  let abortController: AbortController | null = null;

  onMounted(() => {
    void fetchHealth().then((info) => {
      serverMode.value = info?.mode ?? "unknown";
    });
    void refreshUsageSummary();
  });

  async function refreshUsageSummary() {
    usageSummary.value = await fetchUsageSummary();
  }

  // 流式结束后再落盘，避免半成品气泡写进 localStorage
  watch([messages, isStreaming, ragMode], () => {
    if (!isStreaming.value) {
      localStorage.setItem(historyKey(ragMode.value), JSON.stringify(messages.value));
    }
  });

  function persistCurrentHistory() {
    localStorage.setItem(historyKey(ragMode.value), JSON.stringify(messages.value));
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
      }) => Promise<boolean>;
    },
  ) {
    // ---- 1. 开流：本请求专用 AbortController，可被 stop() 打断 ----
    const controller = new AbortController();
    abortController = controller;
    isStreaming.value = true;
    error.value = null;
    toolTrace.value = [];
    lastUsage.value = null;

    // ---- 2. 占位 assistant：先插空气泡，后续 onDelta / onRagMeta 往里灌 ----
    const assistantId = createId();
    let latest: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages.value = [...history, latest];

    const patchLatest = (updater: (prev: ChatMessage) => ChatMessage) => {
      latest = updater(latest);
      messages.value = messages.value.map((message) =>
        message.id === assistantId ? latest : message,
      );
    };

    // ---- 3. 交给具体 API（streamChat / askRag），统一接四类回调 ----
    // 这四个函数由本骨架实现，再原样传给 api 层；api 解析 SSE 后按事件类型回调。
    const done = await options.start({
      signal: controller.signal,
      patchLatest,
      // onDelta：SSE { delta } → 拼进当前 assistant 气泡正文（流式打字）
      onDelta: (delta) => {
        patchLatest((prev) => ({ ...prev, content: prev.content + delta }));
      },
      // onTrace：SSE 过程事件 → ToolTracePanel（tool_call / confirm / injection…）
      onTrace: (step) => {
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
      },
      // onUsage：SSE { type:"usage" } → 本次 Token 摘要 + 刷新汇总面板
      onUsage: (usage) => {
        lastUsage.value = usage;
        void refreshUsageSummary();
      },
      // onError：SSE { error } 或网络失败 → 顶栏/气泡错误文案
      onError: (message) => {
        error.value = message;
      },
    });

    // ---- 4. 收尾：清 abort 引用、关 streaming、补中止/失败文案 ----
    if (abortController === controller) abortController = null;
    isStreaming.value = false;

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
      start: ({ signal, onDelta, onTrace, onUsage, onError }) =>
        streamChat({
          messages: history.map(({ role, content }) => ({ role, content })),
          model: selectedModel,
          signal,
          searchDocs: searchKb.value,
          multiAgent: multiAgent.value,
          // 以下四个来自 runSseSession，实现见上方骨架第 3 步：
          onDelta, // 助手正文流式增量
          onTrace, // 工具/确认/防护过程 → ToolTracePanel
          onUsage, // Token 用量 → UsagePanel
          onError, // 失败文案
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
    const prior = history.slice(0, -1).map(({ role, content }) => ({ role, content }));

    await runSseSession(history, {
      emptyErrorFallback: "资料问答失败。",
      start: ({ signal, patchLatest, onDelta, onTrace, onUsage, onError }) =>
        askRag({
          question,
          history: prior,
          model: selectedModel,
          signal,
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
    await runStream(history, model.value);
  }

  /** 重试：去掉末尾失败/空的 assistant，用最后一条 user 再跑同一链路。 */
  async function retry() {
    if (isStreaming.value) return;
    const current = messages.value;
    const history =
      current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current;
    if (history.length === 0 || history[history.length - 1]?.role !== "user") return;
    if (ragMode.value) {
      await runRag(history, model.value);
      return;
    }
    await runStream(history, model.value);
  }

  function stop() {
    abortController?.abort();
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
    messages.value = [];
    error.value = null;
    toolTrace.value = [];
    lastUsage.value = null;
    localStorage.setItem(historyKey(ragMode.value), "[]");
  }

  function changeModel(nextModel: string) {
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
  }

  return {
    messages,
    model,
    ragMode,
    searchKb,
    multiAgent,
    isStreaming,
    error,
    toolTrace,
    lastUsage,
    usageSummary,
    serverMode,
    send,
    retry,
    stop,
    clear,
    changeModel,
    setRagMode,
    setSearchKb,
    setMultiAgent,
    refreshUsageSummary,
    resolveToolConfirm,
  };
}
