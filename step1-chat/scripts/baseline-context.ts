/**
 * 基线脚本：量化「只按条数截断」到底丢了什么。
 *
 * 用法：
 *   npx tsx scripts/baseline-context.ts --mock    # 不调模型，只看窗口裁剪结果
 *   npx tsx scripts/baseline-context.ts           # 真实模型（需要能连通 LLM_BASE_URL）
 *
 * 每轮打印：发送条数 / 估算 token / system 固定成本占比 / 实际 promptTokens /
 * 窗口里还带不带那个唯一事实。
 * 最后一轮提问这个事实，用来证明「按 8 条截断时，现在答不出来」。
 *
 * 这里的估算器是基线口径，阶段 3 指令 2 会把它抽到公共模块，届时两边必须一致。
 */
import dotenv from "dotenv";
import { clipMessages } from "../server/clipMessages.js";
import { buildSystemPrompt, createChatStream, MAX_CONTEXT_MESSAGES } from "../server/chat.js";
import type { TextMessage } from "../server/react/types.js";
import type { TokenUsage } from "../server/usage/types.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/** 第 1 轮埋进对话的唯一事实。后面最后一轮会问它。 */
const FACT_CODE = "SECRET-4F2A-9C7B";
const DEFAULT_ROUNDS = 10;

const args = process.argv.slice(2);
const forceMock = args.includes("--mock");
const roundsArg = args.find((a) => a.startsWith("--rounds="));
const ROUNDS = roundsArg ? Number(roundsArg.split("=")[1]) : DEFAULT_ROUNDS;

const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
const baseUrl = process.env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
const model = process.env.LLM_MODEL ?? "deepseek-chat";
const useMock = forceMock || !apiKey;

// ---- 估算器（基线口径，指令 2 会抽成公共模块）----
const CJK_PATTERN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + other / 4;
}

function estimateMessageTokens(message: TextMessage): number {
  return estimateTextTokens(message.content) + 4;
}

function estimateMessagesTokens(messages: TextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** 第 1 轮埋事实；最后一轮提问；中间的轮次保持中性，避免触发工具调用干扰用量。 */
function userTextForRound(round: number, total: number): string {
  if (round === 1) {
    return `请记住这串编号，之后我会问起它：FACT_CODE = "${FACT_CODE}"。只回复"已记住"三个字。`;
  }
  if (round === total) {
    return "FACT_CODE 是什么？只回答编号本身，不要解释。";
  }
  return `闲聊第 ${round} 轮：最近在读一本讲分布式系统的书，挺有意思。`;
}

interface RoundStat {
  round: number;
  sentCount: number;
  estimatedTokens: number;
  estimatedSystemTokens: number;
  actualPromptTokens: number | null;
  factInWindow: boolean;
  answerHit: boolean;
}

const history: TextMessage[] = [];
const stats: RoundStat[] = [];

const systemPrompt = buildSystemPrompt(false);
const estimatedSystemTokens = estimateMessageTokens({ role: "system", content: systemPrompt });

console.log(`模型：${model}`);
console.log(`baseUrl：${baseUrl}`);
console.log(`模式：${useMock ? "Mock（不产生 usage）" : "真实模型"}`);
console.log(`窗口条数上限：${MAX_CONTEXT_MESSAGES}`);
console.log(`对话轮数：${ROUNDS}`);
console.log(
  `system prompt 估算 ${estimatedSystemTokens.toFixed(1)} token（固定成本，每轮都要付）`,
);
console.log("");

for (let round = 1; round <= ROUNDS; round += 1) {
  const userText = userTextForRound(round, ROUNDS);
  history.push({ role: "user", content: userText });

  // 线上真正发出去的内容：clipMessages 的结果。
  const outgoing = clipMessages(history, systemPrompt, MAX_CONTEXT_MESSAGES);
  const estimatedTokens = estimateMessagesTokens(outgoing);
  const factInWindow = outgoing.some((message) => message.content.includes(FACT_CODE));

  let answer = "";
  let actualPromptTokens: number | null = null;

  await createChatStream({
    messages: history,
    model,
    apiKey,
    baseUrl,
    forceMock: useMock,
    maxContextMessages: MAX_CONTEXT_MESSAGES,
    onDelta: (delta) => {
      answer += delta;
    },
    onUsage: (usage: TokenUsage) => {
      // 一轮里模型可能被追问多次，promptTokens 累加才是这轮真实开销。
      actualPromptTokens = (actualPromptTokens ?? 0) + usage.promptTokens;
    },
  });

  history.push({ role: "assistant", content: answer });

  const answerHit = answer.includes(FACT_CODE);
  stats.push({
    round,
    sentCount: outgoing.length,
    estimatedTokens,
    estimatedSystemTokens,
    actualPromptTokens,
    factInWindow,
    answerHit,
  });

  const actualText =
    actualPromptTokens === null ? "未运行（Mock 模式不产生 usage）" : String(actualPromptTokens);
  const estimatedSystemShare = ((estimatedSystemTokens / estimatedTokens) * 100).toFixed(1);
  const actualSystemShare =
    actualPromptTokens === null || actualPromptTokens === 0
      ? "未运行"
      : `${((estimatedSystemTokens / actualPromptTokens) * 100).toFixed(1)}%（估算 system ÷ 实际 prompt）`;

  console.log(`──── 第 ${round} 轮 ────`);
  console.log(`提问：${userText}`);
  console.log(
    `发送条数：${outgoing.length}（含 1 条 system，即最近 ${outgoing.length - 1} 条对话）`,
  );
  console.log(
    `估算 token：${estimatedTokens.toFixed(1)}（system ${estimatedSystemTokens.toFixed(1)}，占 ${estimatedSystemShare}%）`,
  );
  console.log(`实际 promptTokens：${actualText}`);
  console.log(`system 占实际 prompt 比例：${actualSystemShare}`);
  console.log(`窗口里还带唯一事实：${factInWindow ? "是" : "否"}`);
  console.log(`回答命中唯一事实：${answerHit ? "是" : "否"}`);
  console.log("");
}

// ---- 汇总 ----
console.log("════ 汇总 ════");
console.log("轮次 | 发送条数 | 估算 token | 实际 promptTokens | 事实仍在窗口 | 答出事实");
for (const stat of stats) {
  console.log(
    [
      String(stat.round).padStart(4),
      String(stat.sentCount).padStart(8),
      stat.estimatedTokens.toFixed(1).padStart(11),
      (stat.actualPromptTokens === null ? "未运行" : String(stat.actualPromptTokens)).padStart(16),
      (stat.factInWindow ? "是" : "否").padStart(14),
      (stat.answerHit ? "是" : "否").padStart(10),
    ].join(" | "),
  );
}

const last = stats[stats.length - 1];
const droppedAt = stats.find((stat) => !stat.factInWindow);
console.log("");
console.log("结论：");
console.log(
  `  - 最后一轮（第 ${last.round} 轮）窗口里还带唯一事实：${last.factInWindow ? "是" : "否"}`,
);
console.log(`  - 最后一轮模型答出唯一事实：${last.answerHit ? "是" : "否"}`);
if (droppedAt) {
  console.log(
    `  - 唯一事实从第 ${droppedAt.round} 轮起就不在窗口里（只撑住了 ${droppedAt.round - 1} 轮）`,
  );
} else {
  console.log(`  - 唯一事实全程都在窗口里`);
}
console.log(
  `  - system prompt 固定成本约占饱和窗口的 ${((estimatedSystemTokens / (stats[stats.length - 1]?.estimatedTokens || 1)) * 100).toFixed(1)}%`,
);
if (useMock) {
  console.log("  - 本次为 Mock 运行：usage 与真实回答质量均未实测。");
  console.log(
    "  - 注意：第 1 轮「答出事实=是」是 Mock 回显提问造成的假阳性，不代表模型真的记住了。",
  );
}
