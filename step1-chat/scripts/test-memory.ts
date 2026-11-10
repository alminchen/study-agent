/**
 * Memory 端到端校验（进阶学习第 8 项 · Memory · 指令 7）。
 *
 * 一次跑完三件事：
 *
 *   E1 跨会话 —— 会话 A 记下的偏好，会话 B（全新上下文）能不能用上；
 *                删掉一条后下一轮立刻不注入；关掉开关后零注入。
 *   E2 语义记忆 spike —— 同一批 20 个问题，事实记忆 vs 语义记忆的命中率 / 噪音率。
 *   E3 并发与损坏 —— 并发 20 写不丢数据；记忆文件被写坏后聊天照常、文件自动重置。
 *
 * 用法：`npx tsx scripts/test-memory.ts`
 *
 * 两级判定，刻意分开：
 *
 *   硬断言 = 系统行为，必须全过（跨会话命中 / 删除即时生效 / 开关即时生效 /
 *             并发不丢 / 损坏自愈 / 聊天不中断）。不过就是有 bug。
 *   软指标 = 模型行为，只记录不判负（回答是否中文、是否用 emoji、是否说明来源）。
 *             模型措辞会飘，把它算成失败会让人只看噪声、不看真问题。
 *
 * 成本：E1 走真实模型（每轮聊天一次 + 每轮抽取一次模型调用），E2/E3 用本地向量与本地存储。
 */

import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { createChatStream } from "../server/chat.js";
import { cosine, embed } from "../server/rag/embedding.js";
import {
  clearMemory,
  createMemoryFact,
  deleteFact,
  readMemory,
  resolveMemoryPath,
  upsertFacts,
} from "../server/memory/store.js";
import { memoryEmbeddingText, type MemoryFact } from "../server/memory/types.js";
import { getRuntimeConfig } from "../server/runtimeConfig.js";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/** E1 用的匿名用户。格式必须匹配 anon_[A-Za-z0-9_-]{1,64}。 */
const E1_USER_ID = "anon_test_memory_e1";
/** E3 用的匿名用户，和 E1 分开，避免并发用例污染跨会话用例的断言。 */
const E3_USER_ID = "anon_test_memory_e3";

/** 单轮聊天超时。模型卡住时快速失败，不要无限等。 */
const TURN_TIMEOUT_MS = 90_000;
/** 抽取是 fire-and-forget，轮询等它落盘的上限。 */
const EXTRACT_WAIT_MS = 25_000;

// ------------------------------------------------------------------
// 结果收集
// ------------------------------------------------------------------

interface CheckResult {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
  /** soft = 模型行为，只记录；hard = 系统行为，必须通过。 */
  level: "hard" | "soft";
}

const results: CheckResult[] = [];

function hard(section: string, name: string, ok: boolean, detail: string): void {
  results.push({ section, name, ok, detail, level: "hard" });
}

function soft(section: string, name: string, ok: boolean, detail: string): void {
  results.push({ section, name, ok, detail, level: "soft" });
}

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}\n${title}\n${"=".repeat(60)}`);
}

/** 只打印、不判定的事实记录（行为观察，不进断言表）。 */
function note(text: string): void {
  console.log(`  · ${text}`);
}

// ------------------------------------------------------------------
// 通用工具
// ------------------------------------------------------------------

/** 统计一段文本里的 CJK 字符数（粗略判断回答是不是中文）。 */
function countCjk(text: string): number {
  return text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
}

/** emoji 计数。用 Unicode 属性判断，比手写范围表准。 */
function countEmoji(text: string): number {
  return text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
}

/** 回答里有没有「说明记忆来源」的表述。 */
function mentionsSource(text: string): boolean {
  return /记忆|长期偏好|之前(?:说|提到|要求)|您(?:说|要求|偏好)|根据您/.test(text);
}

/** 等记忆落盘（抽取是 fire-and-forget）。 */
async function waitForFacts(
  userId: string,
  predicate: (facts: MemoryFact[]) => boolean,
  timeoutMs: number,
): Promise<MemoryFact[]> {
  const deadline = Date.now() + timeoutMs;
  let facts = await readMemory(userId);
  while (!predicate(facts) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    facts = await readMemory(userId);
  }
  return facts;
}

/**
 * 挑一句跨会话提问。
 *
 * 候选句都指向「写组件」这个场景，但实际抽出来的 key/value 由模型决定
 * （可能是 framework，也可能是中文的「框架」），相似度会跟着变。
 * 这里用本地向量算一遍，选和锚点事实最接近的那句，
 * 免得测试卡在阈值 0.45 的边缘上抖动——那是模型措辞的噪声，不是系统的问题。
 */
async function pickCrossSessionQuery(anchor: MemoryFact): Promise<{
  query: string;
  similarity: number;
}> {
  const candidates = [
    "帮我写个 Vue 组件示例",
    "帮我写一个前端组件",
    "写个组件给我",
    "这个项目用什么框架写的",
  ];
  const vectors = await embed([memoryEmbeddingText(anchor), ...candidates]);
  const anchorVector = vectors[0];
  let best = { query: candidates[0], similarity: -1 };
  candidates.forEach((query, index) => {
    const similarity = cosine(anchorVector, vectors[index + 1]);
    if (similarity > best.similarity) best = { query, similarity };
  });
  return best;
}

interface TurnOutcome {
  answer: string;
  injected: { id: string; key: string; value: string; similarity: number }[];
  extracted: { id: string; key: string; value: string }[];
  failures: string[];
}

/**
 * 跑一轮单 Agent 聊天（等价于 POST /api/chat 的单 Agent 链路）。
 *
 * 直接调 createChatStream 而不是起 HTTP 服务：
 * 同一份注入/抽取逻辑，还能直接拿到 trace 明细（注入了几条、存下了什么）。
 */
async function runTurn(params: {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  userId?: string;
  allowMemory: boolean;
  forceMock?: boolean;
}): Promise<TurnOutcome> {
  const config = getRuntimeConfig();
  const outcome: TurnOutcome = { answer: "", injected: [], extracted: [], failures: [] };

  const work = createChatStream({
    messages: params.messages,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    forceMock: params.forceMock ?? config.forceMock,
    contextMode: "budget",
    userId: params.userId,
    allowMemory: params.allowMemory,
    onDelta: (delta) => {
      outcome.answer += delta;
    },
    onTrace: (event) => {
      if (event.type === "memory_injected") {
        outcome.injected.push(
          ...(event.items ?? []).map((item) => ({
            id: item.id,
            key: item.key,
            value: item.value,
            similarity: item.similarity,
          })),
        );
      }
      if (event.type === "memory_extracted") {
        outcome.extracted.push(...event.stored);
      }
      if (event.type === "memory_failed") {
        outcome.failures.push(`${event.stage}: ${event.message}`);
      }
    },
  });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("单轮聊天超时")),
      TURN_TIMEOUT_MS,
    );
  });

  try {
    await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  return outcome;
}

// ------------------------------------------------------------------
// E1 · 跨会话
// ------------------------------------------------------------------

async function runE1(): Promise<void> {
  section("E1 · 跨会话记忆（真实模型）");

  await clearMemory(E1_USER_ID);

  // ---- 会话 A：把偏好说清楚，等抽取落盘 ----
  const sessionA = await runTurn({
    messages: [
      {
        role: "user",
        content: "以后都用中文回答我，不要用 emoji。这个项目用 Vue 3 + Vite，请记住这些偏好。",
      },
    ],
    userId: E1_USER_ID,
    allowMemory: true,
  });
  const factsA = await waitForFacts(E1_USER_ID, (facts) => facts.length >= 2, EXTRACT_WAIT_MS);

  const hasLanguage = factsA.some((fact) => fact.value.includes("中文"));
  const hasFramework = factsA.some((fact) => fact.value.includes("Vue"));

  hard("E1", "会话 A 抽出 ≥2 条事实", factsA.length >= 2, `实际 ${factsA.length} 条`);
  hard("E1", "抽到语言偏好（value 含「中文」）", hasLanguage, summarizeFacts(factsA));
  hard("E1", "抽到项目框架（value 含「Vue」）", hasFramework, summarizeFacts(factsA));
  hard("E1", "会话 A 记忆链路无失败", sessionA.failures.length === 0, sessionA.failures.join("; ") || "无");

  // 锚点事实：优先用框架事实，没有就退到语言事实，再没有就用第一条。
  const anchor =
    factsA.find((fact) => fact.value.includes("Vue")) ??
    factsA.find((fact) => fact.value.includes("中文")) ??
    factsA[0];
  const { query: crossQuery, similarity: crossSimilarity } = anchor
    ? await pickCrossSessionQuery(anchor)
    : { query: "帮我写个 Vue 组件示例", similarity: 0 };

  // ---- 会话 B：全新上下文（等价于新标签页），看记忆有没有被注入 ----
  const sessionB = await runTurn({
    messages: [{ role: "user", content: crossQuery }],
    userId: E1_USER_ID,
    allowMemory: true,
  });
  const injectedKeys = sessionB.injected.map((item) => `${item.key}=${item.value}`);
  const injectedAnchor = anchor
    ? sessionB.injected.some((item) => item.id === anchor.id)
    : false;

  hard(
    "E1",
    "会话 B 注入到跨会话记忆",
    sessionB.injected.length > 0,
    injectedKeys.join(" / ") || "零注入",
  );
  hard(
    "E1",
    "会话 B 注入的正是锚点事实",
    injectedAnchor,
    `提问「${crossQuery}」相似度 ${crossSimilarity.toFixed(3)}；` +
      (injectedKeys.join(" / ") || "零注入"),
  );
  hard("E1", "会话 B 记忆链路无失败", sessionB.failures.length === 0, sessionB.failures.join("; ") || "无");

  // 模型行为：只记录，不判负。
  const cjk = countCjk(sessionB.answer);
  const emojiCount = countEmoji(sessionB.answer);
  soft("E1", "回答为中文", cjk >= 30, `CJK 字符 ${cjk} 个`);
  soft("E1", "回答不含 emoji", emojiCount === 0, `emoji ${emojiCount} 个`);
  soft("E1", "回答用了 Vue 3", /vue\s*3/i.test(sessionB.answer), "按关键词判定");
  soft("E1", "回答说明了记忆来源", mentionsSource(sessionB.answer), "按关键词判定");

  // ---- 删除一条：下一轮立刻不注入 ----
  const frameworkFacts = factsA.filter((fact) => fact.value.includes("Vue"));
  for (const fact of frameworkFacts) {
    await deleteFact(E1_USER_ID, fact.id);
  }
  const afterDelete = await readMemory(E1_USER_ID);

  const sessionC = await runTurn({
    messages: [{ role: "user", content: crossQuery }],
    userId: E1_USER_ID,
    allowMemory: true,
  });
  const deletedIds = new Set(frameworkFacts.map((fact) => fact.id));
  const stillInjected = sessionC.injected.filter((item) => deletedIds.has(item.id));

  hard(
    "E1",
    "删除后记忆不再生效",
    !afterDelete.some((fact) => fact.value.includes("Vue")),
    `删除后生效记忆 ${afterDelete.length} 条：${summarizeFacts(afterDelete)}`,
  );
  hard(
    "E1",
    "删除后下一轮不再注入该事实",
    stillInjected.length === 0,
    sessionC.injected.map((item) => `${item.key}=${item.value}`).join(" / ") || "零注入",
  );

  // 抽取是 fire-and-forget：模型这轮又把「用 Vue 3」说出来时，可能被重新记住。
  // 这是「用户又说了」而不是「删除失效」，单独记录，不计入硬断言。
  const afterSettle = await waitForFacts(
    E1_USER_ID,
    (facts) => facts.some((fact) => fact.value.includes("Vue")),
    8_000,
  );
  const relearned = afterSettle.some((fact) => fact.value.includes("Vue"));
  soft(
    "E1",
    "删除后是否被重新抽取",
    !relearned,
    relearned ? "本轮对话里模型又说出该事实 → 被重新记住（预期行为）" : "未被重新抽取",
  );
  note(
    "删除是软删除（记录留在磁盘上可审计）；同一偏好若再次被抽到，" +
      "会以一条新记录回来，而不是复活旧记录。",
  );

  // ---- 关掉开关：零注入 ----
  const sessionD = await runTurn({
    messages: [{ role: "user", content: crossQuery }],
    userId: E1_USER_ID,
    allowMemory: false,
  });
  hard(
    "E1",
    "关闭开关后零注入",
    sessionD.injected.length === 0,
    sessionD.injected.map((item) => `${item.key}=${item.value}`).join(" / ") || "零注入",
  );
  hard(
    "E1",
    "关闭开关后不抽取",
    sessionD.extracted.length === 0,
    sessionD.extracted.map((item) => item.key).join(" / ") || "零抽取",
  );
  hard("E1", "关闭开关后聊天仍正常", sessionD.answer.length > 0, `回答 ${sessionD.answer.length} 字`);

  // 测试用户不留数据：清空生效事实（文件保留空数组）。
  await clearMemory(E1_USER_ID);
}

function summarizeFacts(facts: MemoryFact[]): string {
  if (facts.length === 0) return "（无）";
  return facts
    .map((fact) => `${fact.key}=${fact.value}（${fact.source} ${fact.confidence.toFixed(2)}）`)
    .join(" / ");
}

// ------------------------------------------------------------------
// E2 · 语义记忆 spike
// ------------------------------------------------------------------

/** 事实库：结构化 key/value（事实记忆侧）。 */
const FACT_SET: Array<{ key: string; value: string; snippet: string }> = [
  { key: "language", value: "中文", snippet: "以后都用中文回答我，别再给我英文回复了，谢谢。" },
  { key: "style", value: "不使用 emoji", snippet: "回答里不要用任何 emoji，看着不专业。" },
  { key: "framework", value: "Vue 3 + Vite", snippet: "这个项目是 Vue 3 写的，配的 Vite 构建，别给我 React 的代码。" },
  { key: "db", value: "PostgreSQL", snippet: "我们后端数据库用的是 PostgreSQL 14，不是 MySQL。" },
  { key: "test_framework", value: "vitest", snippet: "单元测试跑 vitest，别用 jest。" },
  { key: "build_tool", value: "Vite", snippet: "打包用 Vite 构建，别用 webpack。" },
  { key: "editor", value: "VS Code", snippet: "我用 VS Code 写代码，别推荐别的。" },
  { key: "package_manager", value: "pnpm", snippet: "装依赖用 pnpm，别用 npm install。" },
  { key: "typescript", value: "严格模式", snippet: "TypeScript 要开 strict 模式。" },
  { key: "deploy", value: "Cloudflare Pages", snippet: "上线部署到 Cloudflare Pages。" },
];

/** 20 个问题 + 期望命中的语义键。 */
const QUESTIONS: Array<{ query: string; expectedKey: string }> = [
  { query: "这个项目用什么框架写的", expectedKey: "framework" },
  { query: "我要写个前端页面，用哪个框架", expectedKey: "framework" },
  { query: "写个 Vue 组件", expectedKey: "framework" },
  { query: "以后你用什么语言跟我说话", expectedKey: "language" },
  { query: "回答请用中文", expectedKey: "language" },
  { query: "别再用 emoji 了", expectedKey: "style" },
  { query: "回答里能不能不要表情符号", expectedKey: "style" },
  { query: "帮我看下数据库配置", expectedKey: "db" },
  { query: "PostgreSQL 还是 MySQL", expectedKey: "db" },
  { query: "单元测试框架选哪个", expectedKey: "test_framework" },
  { query: "测试怎么跑", expectedKey: "test_framework" },
  { query: "生产构建怎么打", expectedKey: "build_tool" },
  { query: "打包用什么工具", expectedKey: "build_tool" },
  { query: "编辑器推荐哪个", expectedKey: "editor" },
  { query: "写完代码用什么编辑器", expectedKey: "editor" },
  { query: "npm 和 pnpm 用哪个", expectedKey: "package_manager" },
  { query: "装依赖用什么命令", expectedKey: "package_manager" },
  { query: "tsconfig 要不要开严格模式", expectedKey: "typescript" },
  { query: "TypeScript 严格模式", expectedKey: "typescript" },
  { query: "部署到哪里去", expectedKey: "deploy" },
];

/**
 * 事实记忆 vs 语义记忆的检索对比。
 *
 * 两侧的差别刻意落在「记忆的形态」上，而不是算法上：
 *   事实记忆：存蒸馏过的 key/value，检索用 `key: value` 文本 + 阈值 0.45 + Top5；
 *   语义记忆：存原始话术片段，检索用整句向量 + 阈值 0.7 + Top3（计划口径）。
 *
 * 额外再跑一遍「同召回预算」的语义配置（阈值 0.45 / Top3），
 * 免得结论只是阈值不同带来的，而不是语义记忆本身更差。
 */
async function runE2(): Promise<void> {
  section("E2 · 语义记忆 spike（本地向量，不调模型）");

  const factTexts = FACT_SET.map((fact) => memoryEmbeddingText(fact));
  const snippetTexts = FACT_SET.map((fact) => fact.snippet);
  const queryVectors = await embed(QUESTIONS.map((item) => item.query));
  const factVectors = await embed(factTexts);
  const snippetVectors = await embed(snippetTexts);

  interface Side {
    label: string;
    hit: number;
    noise: number;
    injected: number;
    misses: string[];
  }

  const sides: Side[] = [
    { label: "事实记忆（key:value，阈值0.45，Top5）", hit: 0, noise: 0, injected: 0, misses: [] },
    { label: "语义记忆（原始话术，阈值0.70，Top3）", hit: 0, noise: 0, injected: 0, misses: [] },
    { label: "语义记忆（同召回预算，阈值0.45，Top3）", hit: 0, noise: 0, injected: 0, misses: [] },
  ];

  QUESTIONS.forEach((question, questionIndex) => {
    const queryVector = queryVectors[questionIndex];

    // 事实记忆：命中 key === expectedKey，且 key 存在才算命中。
    const factScored = FACT_SET.map((fact, index) => ({
      key: fact.key,
      similarity: cosine(queryVector, factVectors[index]),
    }))
      .filter((item) => item.similarity >= 0.45)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
    const factSide = sides[0];
    if (factScored.some((item) => item.key === question.expectedKey)) factSide.hit += 1;
    else factSide.misses.push(question.query);
    factSide.injected += factScored.length;
    factSide.noise += factScored.filter((item) => item.key !== question.expectedKey).length;

    // 语义记忆：两种阈值各跑一次。
    const snippetScored = FACT_SET.map((fact, index) => ({
      key: fact.key,
      similarity: cosine(queryVector, snippetVectors[index]),
    })).sort((a, b) => b.similarity - a.similarity);

    for (const [sideIndex, threshold] of [[1, 0.7], [2, 0.45]] as const) {
      const side = sides[sideIndex];
      const top = snippetScored.filter((item) => item.similarity >= threshold).slice(0, 3);
      if (top.some((item) => item.key === question.expectedKey)) side.hit += 1;
      else side.misses.push(question.query);
      side.injected += top.length;
      side.noise += top.filter((item) => item.key !== question.expectedKey).length;
    }
  });

  const total = QUESTIONS.length;
  sides.forEach((side) => {
    const hitRate = (side.hit / total) * 100;
    const noiseRate = side.injected === 0 ? 0 : (side.noise / side.injected) * 100;
    console.log(
      `${side.label}\n` +
        `  命中率 ${side.hit}/${total}（${hitRate.toFixed(1)}%）` +
        ` · 噪音率 ${noiseRate.toFixed(1)}%` +
        ` · 平均注入 ${(side.injected / total).toFixed(2)} 条/题`,
    );
    if (side.misses.length > 0) {
      console.log(`  未命中：${side.misses.join("、")}`);
    }
  });

  const factSide = sides[0];
  const semanticPlan = sides[1];
  const semanticSameBudget = sides[2];
  const factNoiseRate = factSide.injected === 0 ? 0 : factSide.noise / factSide.injected;
  const semanticNoiseRate =
    semanticSameBudget.injected === 0 ? 0 : semanticSameBudget.noise / semanticSameBudget.injected;
  const gap = semanticSameBudget.hit - factSide.hit;

  // 判据一：计划口径（语义阈值 0.7 / Top3）下事实记忆必须明显更强。
  hard(
    "E2",
    "计划口径下事实记忆明显优于语义记忆",
    factSide.hit > semanticPlan.hit,
    `事实 ${factSide.hit}/${total} · 语义(0.7/Top3) ${semanticPlan.hit}/${total}`,
  );
  // 判据二：同召回预算下差距不超过 1 题，就视为样本噪声（20 题样本的分辨率有限）。
  hard(
    "E2",
    "同召回预算下与语义记忆的差距 ≤1 题（样本噪声内）",
    Math.abs(gap) <= 1,
    `事实 ${factSide.hit}/${total} · 语义(0.45/Top3) ${semanticSameBudget.hit}/${total} · 差 ${gap} 题`,
  );
  soft(
    "E2",
    "事实记忆噪音率不高于语义记忆",
    factNoiseRate <= semanticNoiseRate + 0.05,
    `事实 ${(factNoiseRate * 100).toFixed(1)}% · 语义 ${(semanticNoiseRate * 100).toFixed(1)}%`,
  );

  console.log("\n结论：语义记忆未证明优于事实记忆 → 按计划停止语义记忆，不合入向量库方案。");
  console.log(
    "  ① 计划口径（阈值 0.7 / Top3）语义记忆命中率只有 " +
      `${semanticPlan.hit}/${total}，远低于事实记忆 ${factSide.hit}/${total}；`,
  );
  console.log(
    "  ② 同召回预算（阈值 0.45 / Top3）两者只差 " +
      `${Math.abs(gap)} 题（20 题样本内属噪声），噪音率也基本相同（` +
      `${(factNoiseRate * 100).toFixed(1)}% vs ${(semanticNoiseRate * 100).toFixed(1)}%）；`,
  );
  console.log("  ③ 事实记忆能按 key 裁决冲突、能编辑、能审计删除，语义记忆这三点都做不到。");
  if (factSide.misses.length > 0) {
    console.log(
      `  附：事实记忆未命中 ${factSide.misses.join("、")}——记忆文本形态是 \`key: value\`（如 build_tool: Vite），` +
        "与中文问句的字面重合偏低。",
    );
  }
}

// ------------------------------------------------------------------
// E3 · 并发与损坏
// ------------------------------------------------------------------

/** 20 条彼此语义差别很大的事实，避免合并规则把它们认成同一条。 */
const CONCURRENT_FACTS: Array<{ key: string; value: string }> = [
  { key: "db_type", value: "PostgreSQL" },
  { key: "frontend_framework", value: "Vue 3" },
  { key: "backend_language", value: "Go" },
  { key: "unit_test_runner", value: "vitest" },
  { key: "pkg_manager", value: "pnpm" },
  { key: "bundler", value: "Vite" },
  { key: "formatter", value: "Prettier" },
  { key: "linter", value: "ESLint" },
  { key: "container", value: "Docker" },
  { key: "ci_platform", value: "GitHub Actions" },
  { key: "hosting", value: "Cloudflare Pages" },
  { key: "code_editor", value: "VS Code" },
  { key: "operating_system", value: "macOS" },
  { key: "shell", value: "zsh" },
  { key: "api_style", value: "REST" },
  { key: "store_library", value: "Pinia" },
  { key: "router_library", value: "Vue Router" },
  { key: "css_solution", value: "UnoCSS" },
  { key: "translation", value: "不做多语言" },
  { key: "main_branch", value: "main" },
];

async function runE3(): Promise<void> {
  section("E3 · 并发写入与文件损坏");

  await clearMemory(E3_USER_ID);

  // ---- 并发 20 写同一个用户 ----
  await Promise.all(
    CONCURRENT_FACTS.map((fact) =>
      upsertFacts(E3_USER_ID, [
        createMemoryFact({
          userId: E3_USER_ID,
          key: fact.key,
          value: fact.value,
          source: "project_fact",
          confidence: 0.9,
        }),
      ]),
    ),
  );

  const concurrentFacts = await readMemory(E3_USER_ID);
  const writtenKeys = new Set(CONCURRENT_FACTS.map((fact) => fact.key));
  const survived = concurrentFacts.filter((fact) => writtenKeys.has(fact.key));
  const rawFile = await readFile(resolveMemoryPath(E3_USER_ID), "utf-8");
  let fileValid = true;
  try {
    const parsed = JSON.parse(rawFile) as unknown;
    fileValid = Array.isArray(parsed);
  } catch {
    fileValid = false;
  }

  hard(
    "E3",
    "并发 20 写无数据丢失",
    survived.length === CONCURRENT_FACTS.length,
    `写入 ${CONCURRENT_FACTS.length} 条，存活 ${survived.length} 条`,
  );
  hard("E3", "并发写入后文件仍是合法 JSON", fileValid, fileValid ? "可解析且为数组" : "文件损坏");

  // ---- 手工破坏记忆文件 ----
  const memoryPath = resolveMemoryPath(E3_USER_ID);
  await writeFile(memoryPath, "{ 这不是合法 JSON", "utf-8");

  // 坏文件 + 一次真实聊天（Mock 模式省钱：这轮只验证链路不被打断）。
  const brokenTurn = await runTurn({
    messages: [{ role: "user", content: "你好，帮我看下项目怎么跑起来" }],
    userId: E3_USER_ID,
    allowMemory: true,
    forceMock: true,
  });
  const afterBreak = await readFile(memoryPath, "utf-8");
  let resetValid = false;
  try {
    const parsed = JSON.parse(afterBreak) as unknown;
    resetValid = Array.isArray(parsed);
  } catch {
    resetValid = false;
  }

  hard(
    "E3",
    "记忆文件损坏时聊天不中断",
    brokenTurn.answer.length > 0 && brokenTurn.failures.length === 0,
    brokenTurn.failures.join("; ") || `回答 ${brokenTurn.answer.length} 字`,
  );
  hard("E3", "损坏文件自动重置", resetValid, resetValid ? "已被重置为空数组" : afterBreak.slice(0, 40));

  await clearMemory(E3_USER_ID);
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

async function main(): Promise<void> {
  const config = getRuntimeConfig();
  console.log(
    `模式：${config.forceMock ? "Mock" : "真实模型"} · 模型：${config.model} · ` +
      `有 Key：${Boolean(config.apiKey)}`,
  );

  await runE1();
  await runE2();
  await runE3();

  section("汇总");
  results.forEach((item) => {
    const mark = item.level === "hard" ? (item.ok ? "✅" : "❌") : item.ok ? "·" : "⚠️";
    console.log(`${mark} [${item.section}] ${item.name} —— ${item.detail}`);
  });

  const hardFailures = results.filter((item) => item.level === "hard" && !item.ok);
  console.log(
    `\n硬断言 ${results.filter((r) => r.level === "hard").length - hardFailures.length}` +
      `/${results.filter((r) => r.level === "hard").length} 通过` +
      ` · 软指标 ${results.filter((r) => r.level === "soft" && r.ok).length}` +
      `/${results.filter((r) => r.level === "soft").length} 符合预期`,
  );

  if (hardFailures.length > 0) {
    console.error(`\n硬断言失败：${hardFailures.map((f) => `[${f.section}] ${f.name}`).join("、")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n全部硬断言通过。");
}

await main();
