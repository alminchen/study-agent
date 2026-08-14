import { onMounted, ref, watch } from "vue";
import { fetchHealth, streamChat } from "../api/chat";
import { askRag } from "../api/rag";
import { MODEL_OPTIONS, type ChatMessage, type ToolTraceStep } from "../types";

const HISTORY_KEY = "step1-chat:history";
const RAG_HISTORY_KEY = "step1-chat:rag-history";
const MODEL_KEY = "step1-chat:model";
const RAG_MODE_KEY = "step1-chat:rag-mode";

let idCounter = 0;
const createId = () => `msg_${Date.now()}_${idCounter++}`;

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
  const messages = ref<ChatMessage[]>(loadHistory(historyKey(ragMode.value)));
  const model = ref(localStorage.getItem(MODEL_KEY) ?? MODEL_OPTIONS[0].id);
  const isStreaming = ref(false);
  const error = ref<string | null>(null);
  const toolTrace = ref<ToolTraceStep[]>([]);
  const serverMode = ref<"mock" | "api" | "unknown">("unknown");
  let abortController: AbortController | null = null;

  onMounted(() => {
    void fetchHealth().then((info) => {
      serverMode.value = info?.mode ?? "unknown";
    });
  });

  watch([messages, isStreaming, ragMode], () => {
    if (!isStreaming.value) {
      localStorage.setItem(historyKey(ragMode.value), JSON.stringify(messages.value));
    }
  });

  function persistCurrentHistory() {
    localStorage.setItem(historyKey(ragMode.value), JSON.stringify(messages.value));
  }

  /** 普通对话：SSE + 工具调用，走 /api/chat。 */
  async function runStream(history: ChatMessage[], selectedModel: string) {
    const controller = new AbortController();
    abortController = controller;
    isStreaming.value = true;
    error.value = null;
    toolTrace.value = [];

    const assistantId = createId();
    let latest: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages.value = [...history, latest];

    const done = await streamChat({
      messages: history.map(({ role, content }) => ({ role, content })),
      model: selectedModel,
      signal: controller.signal,
      onDelta: (delta) => {
        latest = { ...latest, content: latest.content + delta };
        messages.value = messages.value.map((message) =>
          message.id === assistantId ? latest : message,
        );
      },
      onTrace: (step) => {
        toolTrace.value = [...toolTrace.value, step];
      },
      onError: (message) => {
        error.value = message;
      },
    });

    if (abortController === controller) abortController = null;
    isStreaming.value = false;

    if (controller.signal.aborted && latest.content === "") {
      latest = { ...latest, content: "已停止生成。" };
    }
    if (done || controller.signal.aborted) {
      messages.value = messages.value.map((message) =>
        message.id === assistantId ? latest : message,
      );
    }
  }

  /**
   * 资料问答：POST /api/rag/chat。
   * 服务端先检索判空再决定是否调模型；前端只收完整 JSON，等待期间用空气泡 + 光标表示进行中。
   */
  async function runRag(history: ChatMessage[], selectedModel: string) {
    const controller = new AbortController();
    abortController = controller;
    isStreaming.value = true;
    error.value = null;
    toolTrace.value = [];

    const lastUser = [...history].reverse().find((message) => message.role === "user");
    const question = lastUser?.content.trim() ?? "";
    // 当前问句已经在 history 末尾，传给后端的 history 必须去掉它，避免拼 prompt 时重复。
    const prior = history.slice(0, -1).map(({ role, content }) => ({ role, content }));

    const assistantId = createId();
    let latest: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };
    messages.value = [...history, latest];

    const result = await askRag({
      question,
      history: prior,
      model: selectedModel,
      signal: controller.signal,
    });

    if (abortController === controller) abortController = null;
    isStreaming.value = false;

    if (controller.signal.aborted) {
      latest = { ...latest, content: latest.content || "已停止生成。" };
    } else if (!result.ok) {
      error.value = result.error;
      latest = { ...latest, content: latest.content || "资料问答失败。" };
    } else {
      latest = {
        ...latest,
        content: result.data.answer,
        rag: {
          empty: result.data.empty,
          calledModel: result.data.calledModel,
          topScore: result.data.topScore,
          question: result.data.question,
          hits: result.data.hits,
        },
      };
    }

    messages.value = messages.value.map((message) =>
      message.id === assistantId ? latest : message,
    );
  }

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

  function clear() {
    stop();
    messages.value = [];
    error.value = null;
    toolTrace.value = [];
    localStorage.setItem(historyKey(ragMode.value), "[]");
  }

  function changeModel(nextModel: string) {
    model.value = nextModel;
    localStorage.setItem(MODEL_KEY, nextModel);
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
  }

  return {
    messages,
    model,
    ragMode,
    isStreaming,
    error,
    toolTrace,
    serverMode,
    send,
    retry,
    stop,
    clear,
    changeModel,
    setRagMode,
  };
}
