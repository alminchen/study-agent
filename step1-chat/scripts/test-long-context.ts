/**
 * 50 轮长会话验收脚本（指令 6 · E1～E2）。
 *
 * 目的：用一条可控的长对话，检验「长上下文管理」这条链路是不是真的通了——
 * 早期消息被丢掉之后，关键事实还能不能被模型说出来。
 *
 * 用法：
 *   node --import tsx scripts/test-long-context.ts --mode=summary-ok
 *   node --import tsx scripts/test-long-context.ts --mode=summary-broken
 *   node --import tsx scripts/test-long-context.ts --mode=no-summary
 *   node --import tsx scripts/test-long-context.ts --mode=summary-ok --backend=real
 *
 * 三条路径（E2）：
 * - no-summary    只按 token 预算裁剪，完全不生成摘要；
 * - summary-ok    丢掉的内容交给摘要器，摘要成功后用新摘要重建上下文；
 * - summary-broken 摘要器返回非法 JSON，模拟摘要失败。
 *
 * 后端（--backend）：
 * - stub（默认）拦截 fetch，用本地逻辑模拟模型。**这是行为模拟**，
 *   证明的是「裁剪 → 摘要 → 重新注入 → 答得出来」这条管线正确，
 *   不是模型质量。真实模型请用 --backend=real。
 * - real 真连 LLM_BASE_URL。
 */
import dotenv from "dotenv";
import { buildContext } from "../server/context/buildContext.js";
import { buildSystemPrompt, createChatStream, MAX_CONTEXT_ROUNDS } from "../server/chat.js";
import {
  estimateMessagesTokens,
  resolveBudgetTokens,
} from "../server/context/tokenBudget.js";
import type {
  ContextCompactionEvent,
  ContextSummary,
} from "../server/context/types.js";
import { runConversation } from "../server/react/runConversation.js";
import type { TextMessage } from "../server/react/types.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/** 唯一事实的编号。第 3 轮埋进去，第 51 轮问回来。 */
const FACT_CODE = "LCTX-7731";
/** 事实的键名。摘要里渲染成 `FACT_CODE = <编号>`。 */
const FACT_KEY = "FACT_CODE";
/** 最后一轮的提问措辞，stub 后端靠它识别「这轮在问事实」。 */
const QUESTION_PHRASE = "FACT_CODE 是什么";

type Mode = "no-summary" | "summary-ok" | "summary-broken";
type Backend = "stub" | "real";

const args = process.argv.slice(2);

function argValue(prefix: string, fallback: string): string {
  const found = args.find((item) => item.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1) : fallback;
}

const MODE = argValue("--mode", "summary-ok") as Mode;
const BACKEND = argValue("--backend", "stub") as Backend;
const ROUNDS = Number(argValue("--rounds", "51"));
const MAX_ROUNDS = Number(argValue("--max-rounds", String(MAX_CONTEXT_ROUNDS)));
const WINDOW_TOKENS = Number(argValue("--window-tokens", "64000"));
const BUDGET_RATIO = Number(argValue("--budget-ratio", "0.5"));
const FACT_ROUND = 3;
const VERBOSE = args.includes("--verbose");

const API_KEY = process.env.LLM_API_KEY?.trim() ?? "";
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const MODEL = process.env.LLM_MODEL ?? "deepseek-chat";

const systemPrompt = buildSystemPrompt(false);
const budgetTokens = resolveBudgetTokens(WINDOW_TOKENS, BUDGET_RATIO);

/**
 * 服务端的 ReAct 循环每轮都会打印「模型返回 / 交给页面的文字」调试信息，
 * 51 轮下来会把脚本自己的输出淹没。默认静音，需要看细节时加 --verbose。
 *
 * 只静音 console.log：console.warn / console.error 保留，
 * 摘要失败之类的告警照样能看见。
 */
async function withQuietLogs<T>(action: () => Promise<T>): Promise<T> {
  if (VERBOSE) return action();
  const original = console.log;
  console.log = () => {};
  try {
    return await action();
  } finally {
    console.log = original;
  }
}

/**
 * 第 3 轮：埋入唯一事实。
 *
 * 这条消息写得比别的轮次长，是**故意**的：摘要器只在「被丢掉的内容」
 * 估算 token 超过阈值时才被触发（服务端常量 200）。如果这一轮太短，
 * 它会在「单独被丢掉」的那一轮里够不到阈值，事实就会掉在
 * 「已丢弃但没被总结」的缝里——那是真实的行为，但会让本次验收
 * 测不到摘要能不能救回事实。
 */
function factMessage(): string {
  return (
    `请记住下面这个编号，之后我会在对话最后问你它是什么，答不出来就说明上下文管理出了问题：` +
    `${FACT_KEY} = "${FACT_CODE}"。` +
    "这条消息写得比平时长是故意的——长上下文管理不能只靠「按条数截断」，" +
    "丢掉历史时要按 token 预算决定丢多少、留多少，剩下的交给摘要器提炼成结构化记忆，" +
    "所以每一条被丢掉的消息本身也有 token 成本，低于某个阈值的片段不值得单独调一次模型。" +
    "我现在没有别的问题，你只要回复「已记住」三个字就够了，不用复述这个编号，" +
    "也不用解释它是什么用途。"
  );
}

/** 第 4～50 轮：中性闲聊，不含任何需要记住的信息，也不该触发工具调用。 */
function fillerMessage(round: number): string {
  return (
    `闲聊第 ${round} 轮：最近在读一本讲分布式系统的书，讲的是一致性哈希怎么在节点扩容时尽量少搬数据。` +
    "作者的思路是先给每台机器算一个虚拟节点编号，再把数据按区间分给它们，" +
    "扩容的时候只把新节点负责的那几个区间搬过去就完事了。老实说这种讲法比论文好读，" +
    "但真正工程里还得考虑节点挂掉、副本同步延迟、以及跨机房网络抖动这些问题，" +
    "所以实际用起来总比书上麻烦一些。另外作者还聊到虚拟节点的数量到底该怎么定——" +
    "太少会导致负载不均，太多又会让路由表变得很大，这一块他建议按实际流量去压测调整，" +
    "别照抄固定参数。总之这章值得慢慢啃，跟我最近在改的那个会话缓存正好能对上。"
  );
}

/** 最后一轮：把埋进去的事实问回来。 */
function questionMessage(): string {
  return `${QUESTION_PHRASE}？只回答编号本身，不要解释。`;
}

function userTextForRound(round: number, total: number): string {
  // 提问轮优先于埋事实轮：轮数很少时（比如 --rounds=3）两者会撞车。
  if (round === total && total > FACT_ROUND) return questionMessage();
  if (round === FACT_ROUND) return factMessage();
  return fillerMessage(round);
}

// ---------------------------------------------------------------------------
// stub 后端：拦截 fetch，用本地逻辑模拟模型
// ---------------------------------------------------------------------------

/** 摘要请求的 system 提示里带这个标记，用来和聊天请求区分。 */
const SUMMARY_MARKER = "对话摘要器";

/** 从转写文本里取某条消息的下标（行首的 `[n]`）。 */
function transcriptIndexOf(transcript: string, needle: string): number {
  for (const line of transcript.split("\n")) {
    if (!line.includes(needle)) continue;
    const matched = /^\[(\d+)\]/.exec(line);
    if (matched) return Number(matched[1]);
  }
  return -1;
}

/** 转写文本里第一条消息的下标。 */
function firstTranscriptIndex(transcript: string): number {
  const matched = /\[(\d+)\]/.exec(transcript);
  return matched ? Number(matched[1]) : 0;
}

/**
 * 模拟一个「好模型」的摘要器：从转写文本里抽出事实，产出合法 JSON。
 *
 * 它做的事只有一件——把 FACT_CODE 从被丢掉的历史里捞出来，
 * 并**原样抄回来源下标**（服务端靠这个下标判断这条摘要可不可信）。
 */
function buildStubSummary(transcript: string): string {
  const facts: { key: string; value: string; sourceMessageIndex: number }[] = [];
  const matched = new RegExp(`${FACT_KEY}\\s*=\\s*"?([A-Za-z0-9._-]+)"?`).exec(transcript);
  if (matched) {
    const sourceIndex = transcriptIndexOf(transcript, FACT_KEY);
    facts.push({
      key: FACT_KEY,
      value: matched[1],
      sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : firstTranscriptIndex(transcript),
    });
  }
  return JSON.stringify({
    facts,
    // 没有事实的那几轮也要给出**非空**摘要：服务端拿到空摘要会
    // 当作「压缩失败」直接放弃（宁可裸窗口也不假装压成功）。
    decisions: [
      { text: "这段历史已被压缩成摘要", sourceMessageIndex: firstTranscriptIndex(transcript) },
    ],
    unresolved: [],
    userConstraints: [],
  });
}

/** 故意返回非法 JSON：服务端会判定摘要失败，聊天照常继续。 */
const BROKEN_SUMMARY = `{"facts": [{"key": "${FACT_KEY}", "value": "${FACT_CODE}"`;

/**
 * 模拟聊天模型：只根据**它实际收到的 messages** 回答。
 *
 * 这正是验收的关键——事实能不能被答出来，只取决于它有没有进入请求里。
 * stub 不「知道」答案，它只看注入的上下文里有没有那串编号。
 */
function buildStubChatReply(messages: { role: string; content: string }[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const question = lastUser?.content ?? "";
  const joined = messages.map((message) => message.content).join("\n");
  const factInContext = joined.includes(FACT_CODE);
  if (question.includes(QUESTION_PHRASE)) {
    return factInContext
      ? `${FACT_KEY} = ${FACT_CODE}`
      : "当前上下文里找不到那个编号。";
  }
  return "好的。";
}

/** 造一个 OpenAI 兼容的非流式响应。 */
function stubResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "stub-completion",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: MODEL,
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      // stub 不产生真实 usage：全 0 会被服务端解析成「没有 usage」。
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * 装上 stub 后端：拦截全局 fetch。
 *
 * 区分两类请求的方式：聊天请求一定带 `tools` 数组，摘要请求不带。
 */
function installStubBackend(brokenSummary: boolean): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let body: {
      tools?: unknown;
      messages?: { role: string; content: string }[];
    } = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }

    const isSummaryRequest =
      !Array.isArray(body.tools) ||
      (body.messages ?? []).some(
        (message) =>
          message.role === "system" && message.content.includes(SUMMARY_MARKER),
      );

    if (isSummaryRequest) {
      const transcript = body.messages?.[1]?.content ?? "";
      const content = brokenSummary ? BROKEN_SUMMARY : buildStubSummary(transcript);
      return stubResponse(content);
    }

    return stubResponse(buildStubChatReply(body.messages ?? []));
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

// ---------------------------------------------------------------------------
// 三条路径
// ---------------------------------------------------------------------------

interface RoundStat {
  round: number;
  /** 这一轮实际发给模型的 messages 条数（含 system）。 */
  sentCount: number;
  /** 压缩前估算 token：system + 全部历史都发出去要花多少。 */
  beforeTokens: number;
  /** 压缩后估算 token：真正注入模型的内容花了多少。 */
  afterTokens: number;
  /** 摘要自身占的估算 token。 */
  summaryTokens: number;
  /** 本轮是否丢了内容（丢了才可能有压缩事件）。 */
  compacted: boolean;
  /** 本轮是否处于降级状态（摘要不可用）。 */
  degraded: boolean;
  /** 回答里有没有出现那串编号。 */
  factHit: boolean;
  elapsedMs: number;
}

interface RoundOutcome {
  answer: string;
  compaction: ContextCompactionEvent | null;
  /** 传给下一轮的摘要（失败时沿用旧摘要）。 */
  nextSummary: ContextSummary | null;
}

/** 压缩前的估算 token：把 system 和整段历史都算进去。 */
function beforeTokensOf(history: TextMessage[]): number {
  return estimateMessagesTokens([{ role: "system", content: systemPrompt }, ...history]);
}

/**
 * 路径 A / B / C 共用的统计口径。
 *
 * 服务端在摘要成功后会用**新摘要重建**上下文，摘要失败则沿用旧上下文。
 * 这里用同样的参数重算一次 buildContext，保证「压缩后 token」和
 * 「发送条数」跟服务端真正发出去的那份消息完全一致。
 */
function buildEffectiveContext(
  history: TextMessage[],
  previousSummary: ContextSummary | null,
  compaction: ContextCompactionEvent | null,
) {
  const effectiveSummary = compaction?.summary ?? previousSummary;
  return buildContext({
    messages: history,
    summary: effectiveSummary,
    systemPrompt,
    budgetTokens,
    maxRecentRounds: MAX_ROUNDS,
  });
}

/**
 * 路径 B / C：走服务端 `/api/chat` 的同一条链路（budget 模式）。
 *
 * 摘要成功与否由服务端决定，脚本只从 onTrace 里收 `context_compacted` 事件。
 */
async function runBudgetRound(
  history: TextMessage[],
  previousSummary: ContextSummary | null,
  apiKey: string,
): Promise<RoundOutcome> {
  let answer = "";
  const state: { compaction: ContextCompactionEvent | null } = {
    compaction: null,
  };

  await createChatStream({
    messages: history,
    model: MODEL,
    apiKey,
    baseUrl: BASE_URL,
    contextMode: "budget",
    contextSummary: previousSummary,
    contextWindowTokens: WINDOW_TOKENS,
    contextBudgetRatio: BUDGET_RATIO,
    maxContextMessages: MAX_ROUNDS,
    onDelta: (delta) => {
      answer += delta;
    },
    onTrace: (event) => {
      if (event.type === "context_compacted") state.compaction = event;
    },
  });

  return {
    answer,
    compaction: state.compaction,
    nextSummary: state.compaction?.summary ?? previousSummary,
  };
}

/**
 * 路径 A：只按 token 预算裁剪，**完全不生成摘要**。
 *
 * 这里不调 createChatStream——它一定会尝试摘要。用同一套 buildContext
 * 自己拼上下文，再交给同一个 runConversation 走 ReAct，
 * 保证两条路径除了「有没有摘要」以外没有别的差别。
 */
async function runNoSummaryRound(
  history: TextMessage[],
  apiKey: string,
): Promise<RoundOutcome> {
  const context = buildContext({
    messages: history,
    summary: null,
    systemPrompt,
    budgetTokens,
    maxRecentRounds: MAX_ROUNDS,
  });

  let answer = "";
  await runConversation(
    {
      messages: context.messages,
      model: MODEL,
      baseUrl: BASE_URL,
      onDelta: (delta) => {
        answer += delta;
      },
    },
    apiKey,
  );

  return { answer, compaction: null, nextSummary: null };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const useStub = BACKEND === "stub";
  // stub 也要给一个非空 Key：服务端见到空 Key 会走 Mock 假流式，
  // 那样就完全不会发请求，也就测不到摘要这一段了。
  const apiKey = useStub ? "stub-key" : API_KEY;
  if (!useStub && !apiKey) {
    console.log("没有 LLM_API_KEY，请先配置，或改用 --backend=stub。");
    return;
  }

  const restoreFetch = useStub ? installStubBackend(MODE === "summary-broken") : () => {};

  console.log(`模式：${MODE}`);
  console.log(`后端：${useStub ? "stub（本地模拟模型，验证管线行为）" : `real（${BASE_URL}）`}`);
  console.log(`模型：${MODEL}`);
  console.log(`对话轮数：${ROUNDS}（第 ${FACT_ROUND} 轮埋事实，第 ${ROUNDS} 轮问回来）`);
  if (ROUNDS <= FACT_ROUND + 1) {
    console.log(
      `⚠️ 轮数太少：第 ${FACT_ROUND} 轮埋进去的事实来不及被问回来，结论必然是「未命中」。`,
    );
  }
  console.log(`保留近期原文：最多 ${MAX_ROUNDS} 轮`);
  console.log(
    `token 预算：窗口 ${WINDOW_TOKENS} × 比例 ${BUDGET_RATIO} = ${budgetTokens}`,
  );
  if (useStub) {
    console.log("");
    console.log("⚠️ 本次为 stub 后端：验证的是「裁剪 → 摘要 → 重新注入 → 答得出来」");
    console.log("   这条管线是否正确，**不代表真实模型的摘要质量或回答质量**。");
  }
  console.log("");

  const history: TextMessage[] = [];
  let currentSummary: ContextSummary | null = null;
  let lastAnswer = "";
  const stats: RoundStat[] = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    history.push({ role: "user", content: userTextForRound(round, ROUNDS) });

    const started = Date.now();
    const outcome =
      MODE === "no-summary"
        ? await withQuietLogs(() => runNoSummaryRound(history, apiKey))
        : await withQuietLogs(() => runBudgetRound(history, currentSummary, apiKey));
    const elapsedMs = Date.now() - started;
    lastAnswer = outcome.answer;

    const context = buildEffectiveContext(history, currentSummary, outcome.compaction);
    const stat: RoundStat = {
      round,
      sentCount: context.messages.length,
      beforeTokens: beforeTokensOf(history),
      afterTokens: context.estimatedTokens,
      summaryTokens: outcome.compaction?.summaryTokens ?? 0,
      // 无摘要路径没有压缩事件，但内容确实被裁掉了——用 dropped 判断。
      compacted:
        MODE === "no-summary"
          ? context.droppedMessages.length > 0
          : outcome.compaction !== null,
      degraded:
        MODE === "no-summary" ? context.degraded : (outcome.compaction?.degraded ?? false),
      factHit: outcome.answer.includes(FACT_CODE),
      elapsedMs,
    };
    stats.push(stat);

    history.push({ role: "assistant", content: outcome.answer });
    currentSummary = outcome.nextSummary;

    console.log(
      [
        `第 ${String(round).padStart(2)} 轮`,
        `发送 ${String(stat.sentCount).padStart(3)} 条`,
        `压缩前 ${stat.beforeTokens.toFixed(1).padStart(8)}`,
        `压缩后 ${stat.afterTokens.toFixed(1).padStart(8)}`,
        `摘要开销 ${String(stat.summaryTokens).padStart(6)}`,
        stat.compacted ? (stat.degraded ? "降级 是" : "降级 否") : "未压缩    ",
        `事实命中 ${stat.factHit ? "是" : "否"}`,
        `${stat.elapsedMs}ms`,
      ].join(" | "),
    );
  }

  printSummary(stats, lastAnswer);
  restoreFetch();
}

/** 汇总表 + 结论块。 */
function printSummary(stats: RoundStat[], lastAnswer: string): void {
  console.log("");
  console.log("════ 汇总 ════");
  console.log(
    "轮次 | 发送条数 | 压缩前 token | 压缩后 token | 摘要开销 | 压缩 | 降级 | 事实命中 | 耗时",
  );
  for (const stat of stats) {
    console.log(
      [
        String(stat.round).padStart(4),
        String(stat.sentCount).padStart(8),
        stat.beforeTokens.toFixed(1).padStart(12),
        stat.afterTokens.toFixed(1).padStart(12),
        String(stat.summaryTokens).padStart(8),
        (stat.compacted ? "是" : "否").padStart(4),
        (stat.degraded ? "是" : "否").padStart(4),
        (stat.factHit ? "是" : "否").padStart(8),
        `${stat.elapsedMs}ms`.padStart(7),
      ].join(" | "),
    );
  }

  const last = stats[stats.length - 1];
  const firstCompacted = stats.find((stat) => stat.compacted);
  const summaryCalls = stats.filter((stat) => stat.summaryTokens > 0).length;
  const summaryTokensTotal = stats.reduce((sum, stat) => sum + stat.summaryTokens, 0);
  const degradedRounds = stats.filter((stat) => stat.degraded).length;
  const compactedRounds = stats.filter((stat) => stat.compacted).length;
  const peakBefore = Math.max(...stats.map((stat) => stat.beforeTokens));
  const peakAfter = Math.max(...stats.map((stat) => stat.afterTokens));

  console.log("");
  console.log("结论：");
  console.log(`  - 最后一轮（第 ${last.round} 轮）回答命中唯一事实：${last.factHit ? "是" : "否"}`);
  console.log(`  - 最后一轮回答：${lastAnswer.trim() || "（空）"}`);
  console.log(
    firstCompacted
      ? `  - 首次发生压缩：第 ${firstCompacted.round} 轮（历史超过 ${MAX_ROUNDS} 轮上限）`
      : "  - 全程未发生压缩",
  );
  console.log(`  - 发生压缩的轮数：${compactedRounds} / ${stats.length}`);
  console.log(
    `  - 压缩前峰值 ${peakBefore.toFixed(1)} token → 压缩后峰值 ${peakAfter.toFixed(1)} token` +
      `（省 ${(peakBefore - peakAfter).toFixed(1)}，` +
      `${peakAfter > 0 ? (((peakBefore - peakAfter) / peakBefore) * 100).toFixed(1) : "0.0"}%）`,
  );
  console.log(
    `  - 摘要开销合计 ${summaryTokensTotal} token（成功生成 ${summaryCalls} 次，` +
      `${summaryCalls > 0 ? `平均 ${(summaryTokensTotal / summaryCalls).toFixed(1)}` : "0.0"} token/次）`,
  );
  console.log(`  - 降级（摘要不可用）轮数：${degradedRounds}`);

  console.log("");
  console.log("判定：");
  if (MODE === "summary-ok") {
    const passed = last.factHit && degradedRounds === 0;
    console.log(
      `  - 期望：摘要成功时第 ${last.round} 轮答得出事实，且没有降级轮。`,
    );
    console.log(`  - 实际：命中=${last.factHit ? "是" : "否"}，降级轮数=${degradedRounds}。`);
    console.log(`  - ${passed ? "通过 ✅" : "未通过 ❌"}`);
  } else if (MODE === "summary-broken") {
    const passed = degradedRounds > 0 && lastAnswer.trim().length > 0;
    console.log("  - 期望：摘要返回非法 JSON 时降级（degraded=true），且聊天不中断。");
    console.log(
      `  - 实际：降级轮数=${degradedRounds}，最后一轮仍有回答=${lastAnswer.trim().length > 0 ? "是" : "否"}。`,
    );
    console.log(`  - ${passed ? "通过 ✅" : "未通过 ❌"}`);
  } else {
    const passed = !last.factHit;
    console.log("  - 期望：无摘要时事实随历史一起被裁掉，答不出来。");
    console.log(`  - 实际：命中=${last.factHit ? "是" : "否"}。`);
    console.log(`  - ${passed ? "通过 ✅" : "未通过 ❌"}`);
  }
  if (BACKEND === "stub") {
    console.log("");
    console.log("  ⚠️ 以上判定基于 stub 后端，只说明管线行为正确；");
    console.log("     真实模型的摘要质量与回答质量未实测。");
  }
}

main().catch((error) => {
  console.error("脚本执行失败：", error);
  if (BACKEND === "real") {
    console.error("提示：真实网关不可达时，可以先用 --backend=stub 验证管线行为。");
  }
  process.exitCode = 1;
});
